/**
 * Interactive QR login for the personal WeChat channel.
 *
 * Full upstream state machine (protocol doc §"QR-code login"):
 *
 *   wait ──scan──▶ scaned ──confirm──▶ confirmed
 *    │               │
 *    ├─ need_verifycode ─▶ prompt(promptText) ─▶ poll with &verify_code=
 *    ├─ verify_code_blocked ─▶ refresh QR (max 3) ─▶ poll
 *    ├─ expired ─▶ refresh QR (max 3)
 *    ├─ scaned_but_redirect ─▶ switch polling host (trusted *.weixin.qq.com)
 *    └─ binded_redirect ─▶ already bound; existing local credential stays valid
 *
 * The adapter never renders the QR code itself: `onQr({ qrcode, imageContent,
 * expiresAt })` hands the payload to the CLI (which uses `qrcode-terminal`), and
 * `print(text)` renders plain prose. No token is ever printed.
 *
 * CLI usage (see `src/cli.js`):
 *
 * ```js
 * import { runWeixinLogin } from './src/adapters/weixin/login.js';
 * const result = await runWeixinLogin({
 *   stateDir, config, print, prompt, onQr, onStatus, signal,
 * });
 * // => { ilinkBotId, userId?, baseUrl }  (credential file written)
 * ```
 *
 * @see docs/channels/weixin.md §2
 */
import { ILinkClient, WeixinAbortError } from './client.js';
import { normalizeWeixinConfig, validateWeixinConfig } from './config.js';
import { readCredential, writeCredential } from './credentials.js';
import { assertTrustedBaseUrl, describeError } from './protocol.js';

// Re-export the credential helpers so the CLI can use a single module
// (`import { readCredential, ... } from './adapters/weixin/login.js'`).
export {
  CREDENTIAL_VERSION,
  credentialFileSignature,
  credentialPath,
  deleteCredential,
  deleteCredentialFile,
  readCredential,
  readCredentialFile,
  redactCredential,
  writeCredential,
  writeCredentialFile,
} from './credentials.js';

const MAX_QR_REFRESH = 3;
const POLL_INTERVAL_MS = 1_000;

/**
 * Abortable delay used between QR status polls.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(onDone, Math.max(0, ms));
    timer.unref?.();
    function onDone() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run the QR login flow, store the credential on success.
 *
 * @param {{
 *   stateDir: string,
 *   config?: Record<string, unknown>,
 *   fetch?: typeof fetch,
 *   transport?: unknown,
 *   print?: (text: string) => void,
 *   prompt?: (question: string) => Promise<string>,
 *   onQr?: (qr: { qrcode: string, imageContent: string, expiresAt: number }) => void,
 *   onStatus?: (status: { status: string, detail?: string }) => void,
 *   signal?: AbortSignal,
 *   now?: () => number,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   rand?: () => number,
 * }} options
 * @returns {Promise<{ ilinkBotId: string, userId?: string, baseUrl: string }>}
 */
export async function runWeixinLogin(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('runWeixinLogin requires an options object');
  }
  const stateDir = String(options.stateDir ?? '.');
  const config = validateWeixinConfig(normalizeWeixinConfig(options.config ?? {}));
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const sleep = typeof options.sleep === 'function' ? options.sleep : delay;
  const print = typeof options.print === 'function' ? options.print : () => {};
  const prompt = options.prompt;
  const onQr = typeof options.onQr === 'function' ? options.onQr : null;
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
  const signal = options.signal;

  if (signal?.aborted) throw new WeixinAbortError('login');

  /** @param {string} status @param {string} [detail] */
  const emitStatus = (status, detail) => {
    try {
      onStatus?.({ status, ...(detail !== undefined ? { detail } : {}) });
    } catch {
      // Status observers are UI-only; never fail login because of them.
    }
  };

  const existing = readCredential(stateDir, config);
  const client = new ILinkClient({
    baseUrl: config.baseUrl,
    cdnBaseUrl: config.cdnBaseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    longPollTimeoutMs: config.longPollTimeoutMs,
    botAgent: config.botAgent,
    ...(config.routeTag ? { routeTag: config.routeTag } : {}),
    ...(typeof options.fetch === 'function' ? { fetch: options.fetch } : {}),
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
    ...(now ? { now } : {}),
    ...(typeof options.rand === 'function' ? { rand: options.rand } : {}),
  });

  /** @type {{ qrcode: string, qrcode_img_content: string } | null} */
  let qr = null;
  let qrRefreshes = 0;
  let scannedPrinted = false;
  let pendingVerify = false;
  let verifyCode;

  /**
   * Fetch a QR code (initial or refreshed) and announce it.
   * @param {boolean} refreshed
   */
  async function fetchQr(refreshed) {
    const response = await client.getBotQrcode({
      botType: config.botType,
      localTokens: existing?.token ? [existing.token] : [],
      ...(signal ? { signal } : {}),
    });
    qr = response;
    const issuedAt = now();
    if (refreshed) print('已刷新二维码，请重新扫描。');
    try {
      onQr?.({
        qrcode: response.qrcode,
        // Always hand the CLI something renderable; the server occasionally
        // omits qrcode_img_content and the QR value itself is a URL.
        imageContent: response.qrcode_img_content !== '' ? response.qrcode_img_content : response.qrcode,
        expiresAt: issuedAt + config.loginTimeoutMs,
      });
    } catch {
      // UI callback failure must not abort the login.
    }
    if (onQr === null) {
      print('请使用手机微信扫描以下二维码：');
      print(response.qrcode_img_content !== '' ? response.qrcode_img_content : response.qrcode);
    }
    emitStatus('wait', '二维码已生成，等待扫码');
  }

  print('正在获取微信登录二维码…');
  await fetchQr(false);

  const maxQrRefresh = Number.isInteger(config.maxQrRefresh) && config.maxQrRefresh > 0 ? config.maxQrRefresh : MAX_QR_REFRESH;
  const deadline = now() + config.loginTimeoutMs;
  while (now() < deadline) {
    if (signal?.aborted) throw new WeixinAbortError('login');
    /** @type {Record<string, any>} */
    let statusResponse;
    try {
      statusResponse = await client.getQrcodeStatus({
        qrcode: qr?.qrcode ?? '',
        ...(verifyCode !== undefined ? { verifyCode } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof WeixinAbortError || signal?.aborted) throw new WeixinAbortError('login');
      print(`二维码状态查询失败，正在重试：${describeError(error)}`);
      await sleep(POLL_INTERVAL_MS, signal);
      continue;
    }

    const status = typeof statusResponse.status === 'string' ? statusResponse.status : 'wait';
    switch (status) {
      case 'wait': {
        emitStatus('wait');
        break;
      }
      case 'scaned': {
        if (pendingVerify) {
          pendingVerify = false;
          verifyCode = undefined;
        }
        if (!scannedPrinted) {
          scannedPrinted = true;
          print('已扫码，请在手机微信上确认登录。');
        }
        emitStatus('scaned');
        break;
      }
      case 'need_verifycode': {
        if (typeof prompt !== 'function') {
          throw new Error('登录需要输入手机微信显示的验证码，但当前环境无法交互输入，请在终端中运行登录命令');
        }
        emitStatus('need_verifycode');
        const question = pendingVerify
          ? '验证码不正确，请重新输入手机微信显示的数字：'
          : '请输入手机微信显示的数字验证码：';
        pendingVerify = true;
        let code = '';
        try {
          code = String((await prompt(question)) ?? '').trim();
        } catch (error) {
          throw new Error(`读取验证码失败：${describeError(error)}`);
        }
        if (code === '') throw new Error('未输入验证码，登录已取消');
        verifyCode = code;
        print('已提交验证码，继续等待确认…');
        // Poll immediately with the code instead of waiting a full interval.
        continue;
      }
      case 'expired': {
        qrRefreshes += 1;
        emitStatus('expired');
        if (qrRefreshes > maxQrRefresh) {
          throw new Error('二维码多次过期，登录已停止，请重新运行登录命令');
        }
        print(`二维码已过期，正在刷新（${qrRefreshes}/${maxQrRefresh}）…`);
        await fetchQr(true);
        scannedPrinted = false;
        verifyCode = undefined;
        pendingVerify = false;
        break;
      }
      case 'verify_code_blocked': {
        verifyCode = undefined;
        pendingVerify = false;
        qrRefreshes += 1;
        emitStatus('verify_code_blocked');
        print('验证码错误次数过多，请稍后重试。');
        if (qrRefreshes > maxQrRefresh) {
          throw new Error('验证码多次输入错误，登录已停止，请稍后重新运行登录命令');
        }
        print(`正在刷新二维码（${qrRefreshes}/${maxQrRefresh}）…`);
        await fetchQr(true);
        scannedPrinted = false;
        break;
      }
      case 'scaned_but_redirect': {
        const redirectHost = typeof statusResponse.redirect_host === 'string' ? statusResponse.redirect_host.trim() : '';
        if (redirectHost === '') {
          print('服务器要求切换登录线路但未提供主机名，继续使用当前线路。');
          emitStatus('scaned_but_redirect', 'missing redirect_host');
          break;
        }
        try {
          const redirected = assertTrustedBaseUrl(`https://${redirectHost}`, { configuredBaseUrl: config.baseUrl });
          client.setBaseUrl(redirected);
        } catch (error) {
          throw new Error(`微信返回了不受信任的登录跳转地址，已中止登录（${describeError(error)}）`);
        }
        emitStatus('scaned_but_redirect', `切换到 ${redirectHost}`);
        break;
      }
      case 'binded_redirect': {
        emitStatus('binded_redirect');
        const current = readCredential(stateDir, config);
        if (current !== undefined) {
          print('该微信已绑定本网关，无需重复登录。');
          return {
            ilinkBotId: current.ilinkBotId,
            ...(current.userId ? { userId: current.userId } : {}),
            baseUrl: current.baseUrl,
          };
        }
        throw new Error('服务器报告该微信已绑定，但本地没有可用凭据；请重试或先清理凭据后再扫码');
      }
      case 'confirmed': {
        const botToken = typeof statusResponse.bot_token === 'string' ? statusResponse.bot_token.trim() : '';
        const ilinkBotId = typeof statusResponse.ilink_bot_id === 'string' ? statusResponse.ilink_bot_id.trim() : '';
        if (botToken === '' || ilinkBotId === '') {
          throw new Error('登录失败：服务器未返回 bot_token 或 ilink_bot_id');
        }
        let baseUrl;
        try {
          baseUrl =
            typeof statusResponse.baseurl === 'string' && statusResponse.baseurl.trim() !== ''
              ? assertTrustedBaseUrl(statusResponse.baseurl, { configuredBaseUrl: config.baseUrl })
              : client.baseUrl;
        } catch (error) {
          throw new Error(`登录失败：服务器返回了不受信任的 API 地址（${describeError(error)}）`);
        }
        const userId =
          typeof statusResponse.ilink_user_id === 'string' && statusResponse.ilink_user_id.trim() !== ''
            ? statusResponse.ilink_user_id.trim()
            : undefined;
        writeCredential(stateDir, config, {
          version: 1,
          token: botToken,
          ilinkBotId,
          ...(userId ? { userId } : {}),
          baseUrl,
          savedAt: new Date(now()).toISOString(),
        }, { now });
        emitStatus('confirmed', `已登录 ${ilinkBotId}`);
        print(`登录成功：${ilinkBotId}`);
        return { ilinkBotId, ...(userId ? { userId } : {}), baseUrl };
      }
      default: {
        emitStatus(status, '未知状态，继续等待');
        print(`收到未知的二维码状态（${status}），继续等待…`);
        break;
      }
    }

    await sleep(POLL_INTERVAL_MS, signal);
    if (signal?.aborted) throw new WeixinAbortError('login');
  }

  throw new Error('登录超时：二维码未在有效期内确认，请重新运行登录命令');
}
