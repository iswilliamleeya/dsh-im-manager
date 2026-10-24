/**
 * Browser half of dsh-im-manager — native page styled after the built-in
 * Plugins page (same typography, list rows, toolbar and dark-mode tokens).
 *
 * Data/actions use the host-registered same-origin RPC route `/im-manager`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-im-manager',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const ui = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = react.createElement;
    const { useState, useEffect, useRef } = react;
    const {
      Button,
      Input,
      IconPlusOutlineRegular,
      IconRefreshOutlineRegular,
      IconChevronRightOutlineRegular,
      IconChevronLeftOutlineMedium,
      IconTrashOutlineRegular,
    } = ui;

    const PANEL_ID = 'im-manager';
    // Focusable descendants used by the dialog focus trap / initial focus.
    const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';
    let dialogSeq = 0;
    const CHANNELS = [
      { id: 'feishu', name: '飞书', glyph: '飞', qr: true, config: true },
      { id: 'dingtalk', name: '钉钉', glyph: '钉', qr: false, config: true },
      { id: 'wecom', name: '企业微信', glyph: '企', qr: false, config: true },
      { id: 'weixin', name: '微信（个人）', glyph: '微', qr: true, config: false },
    ];

    const FIELDS = {
      feishu: [
        { key: 'mode', label: '连接模式', type: 'select', options: [['ws', '长连接 ws'], ['webhook', 'Webhook']] },
        { key: 'appId', label: 'App ID', placeholder: 'cli_…' },
        { key: 'appSecret', label: 'App Secret', secret: true },
        { key: 'domain', label: 'Domain', type: 'select', options: [['feishu', 'feishu（中国版）'], ['lark', 'lark（国际版）']] },
        { key: 'webhookPath', label: 'Webhook Path', placeholder: '/webhook/feishu' },
        { key: 'verificationToken', label: 'Verification Token', secret: true },
        { key: 'encryptKey', label: 'Encrypt Key', secret: true },
        { key: 'botOpenId', label: 'Bot Open ID', placeholder: 'ou_…（可选）' },
        { key: 'botName', label: 'Bot Name', placeholder: '可选' },
      ],
      dingtalk: [
        { key: 'mode', label: '连接模式', type: 'select', options: [['stream', 'Stream 长连接'], ['webhook', 'Webhook']] },
        { key: 'clientId', label: 'Client ID（AppKey）', placeholder: 'ding…' },
        { key: 'clientSecret', label: 'Client Secret', secret: true },
        { key: 'robotCode', label: 'Robot Code', placeholder: '留空默认等于 Client ID' },
        { key: 'signatureSecret', label: 'Signature Secret', secret: true, placeholder: '留空默认等于 Client Secret' },
        { key: 'webhookPath', label: 'Webhook Path', placeholder: '/webhook/dingtalk' },
        { key: 'botUserId', label: 'Bot User ID', placeholder: '可选' },
      ],
      wecom: [
        { key: 'mode', label: '连接模式', type: 'select', options: [['ws', '智能机器人 ws'], ['webhook', 'Webhook 自建应用']] },
        { key: 'botId', label: 'Bot ID', placeholder: 'ws 模式' },
        { key: 'secret', label: 'Secret', secret: true },
        { key: 'token', label: 'Token', secret: true },
        { key: 'encodingAESKey', label: 'EncodingAESKey', secret: true },
        { key: 'corpId', label: 'Corp ID' },
        { key: 'agentId', label: 'Agent ID' },
        { key: 'webhookPath', label: 'Webhook Path', placeholder: '/webhook/wecom' },
        { key: 'wsUrl', label: 'WS URL', placeholder: '可留空' },
      ],
    };

    const CSS = `
.dim-page{--dim-space-1:4px;--dim-space-2:8px;--dim-space-3:12px;--dim-space-4:16px;--dim-space-6:24px;--dim-space-8:32px;--dim-space-12:48px;--dim-space-field:14px;box-sizing:border-box;height:100%;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;align-items:center;gap:var(--dim-space-6);padding:0 clamp(24px,4vw,48px) 48px;overflow:auto;font:var(--dsw-font-xs-13)}
.dim-page>*{width:100%;max-width:960px}
.dim-pageHead{box-sizing:border-box;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:var(--dim-space-4);padding-top:var(--dim-space-6)}
[data-platform=darwin] .dim-pageHead,[data-windows-titlebar] .dim-pageHead{padding-top:calc(var(--dim-space-6) + var(--dsh-frame-top-clearance,0px))}
.dim-heading{min-width:0;max-width:100%}
.dim-title{margin:0;font:var(--dsw-font-xl-24)}
.dim-intro{color:var(--dsw-alias-label-tertiary);align-items:center;gap:var(--dim-space-1);margin:var(--dim-space-1) 0 0;font:var(--dsw-font-xxs-12);display:flex;flex-wrap:wrap}
.dim-toolbar{white-space:nowrap;flex:none;justify-content:flex-end;align-items:center;gap:var(--dim-space-2);display:flex;flex-wrap:wrap}
.dim-group{flex-direction:column;gap:var(--dim-space-2);display:flex}
.dim-groupHead{align-items:center;gap:var(--dim-space-2);display:flex}
.dim-groupTitle{flex:1;margin:0;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-strong-13)}
.dim-groupCount{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.dim-cards{flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;display:flex}
.dim-card{border-radius:var(--dsw-radius-xl);margin:0 calc(var(--dim-space-2)*-1);min-width:0;transition:background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.dim-cardHead{align-items:center;gap:var(--dim-space-3);padding:var(--dim-space-2);display:flex;border-radius:var(--dsw-radius-xl)}
.dim-cardHeadClick{cursor:pointer}
.dim-card:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dim-cardHeadClick:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dim-cardIcon{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);width:48px;height:48px;color:var(--dsw-alias-label-secondary);flex:none;justify-content:center;align-items:center;display:inline-flex}
.dim-cardMain{flex-direction:column;flex:1;gap:var(--dim-space-1);min-width:0;display:flex}
.dim-titleRow{flex-wrap:wrap;align-items:center;gap:var(--dim-space-2);min-width:0;display:flex}
.dim-cardTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xs-strong-13)}
.dim-cardDesc{overflow:hidden;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xxs-12)}
.dim-cardMeta{overflow:hidden;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xxs-12);font-family:var(--dsh-font-family-code-default)}
.dim-cardEnd{z-index:1;flex:none;align-items:center;gap:var(--dim-space-2);display:inline-flex;position:relative}
.dim-state{color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none;align-items:center;gap:var(--dim-space-1);font:var(--dsw-font-xs-13);display:inline-flex}
.dim-chevron{color:var(--dsw-alias-label-tertiary);flex:none}
.dim-tag{height:20px;padding:0 var(--dim-space-1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;font:var(--dsw-font-xxxs-11)}
.dim-tagOk{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary)}
.dim-tagErr{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}
.dim-empty{color:var(--dsw-alias-label-tertiary);margin:0;font:var(--dsw-font-xs-13)}
.dim-emptyState{color:var(--dsw-alias-label-tertiary);margin:0;padding:var(--dim-space-6) 0;text-align:center;font:var(--dsw-font-xs-13)}
.dim-failure{color:var(--dsw-alias-state-error-primary);align-items:center;gap:var(--dim-space-2);display:flex;overflow-wrap:anywhere;font:var(--dsw-font-xs-13)}
.dim-detail{flex-direction:column;display:flex;width:100%}
.dim-detailTop{padding-top:var(--dim-space-6);display:flex;flex-direction:column}
[data-platform=darwin] .dim-detailTop,[data-windows-titlebar] .dim-detailTop{padding-top:calc(var(--dim-space-6) + var(--dsh-frame-top-clearance,0px))}
.dim-crumb{color:var(--dsw-alias-label-tertiary);background:0 0;border:0;cursor:pointer;align-items:center;gap:var(--dim-space-1);padding:0;display:inline-flex;font:var(--dsw-font-xs-13);transition:color var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.dim-crumb:hover{color:var(--dsw-alias-label-primary)}
.dim-crumb:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dim-detailHead{justify-content:space-between;align-items:center;gap:var(--dim-space-3);margin:var(--dim-space-6) 0 0;display:flex;flex-wrap:wrap}
.dim-detailMain{flex-direction:column;gap:var(--dim-space-2);min-width:0;margin-top:var(--dim-space-4);display:flex}
.dim-detailTitle{margin:0;overflow-wrap:anywhere;font:var(--dsw-font-l-20)}
.dim-detailDesc{color:var(--dsw-alias-label-secondary);margin:0;overflow-wrap:anywhere;font:var(--dsw-font-xs-13)}
.dim-detailMeta{color:var(--dsw-alias-label-tertiary);margin:0;overflow-wrap:anywhere;font:var(--dsw-font-xxs-12);font-family:var(--dsh-font-family-code-default)}
.dim-detailSections{flex-direction:column;gap:var(--dim-space-6);margin-top:var(--dim-space-6);display:flex}
.dim-section{flex-direction:column;gap:var(--dim-space-3);display:flex}
.dim-sectionHead{align-items:baseline;gap:var(--dim-space-2);display:flex;justify-content:space-between}
.dim-sectionTitle{margin:0;font:var(--dsw-font-m-18)}
.dim-sectionCount{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.dim-rows{flex-direction:column;margin:0;padding:0;list-style:none;display:flex}
.dim-row{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:var(--dim-space-3) 2px;display:flex;align-items:center;gap:var(--dim-space-3)}
.dim-row:last-child{border-bottom:0}
.dim-rowIcon{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);width:40px;height:40px;color:var(--dsw-alias-label-secondary);flex:none;justify-content:center;align-items:center;display:inline-flex;font:var(--dsw-font-xs-13)}
.dim-rowMain{flex-direction:column;flex:1;gap:var(--dim-space-1);min-width:0;display:flex}
.dim-rowId{color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;font:var(--dsw-font-xs-strong-13)}
.dim-rowDesc{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;font:var(--dsw-font-xxs-12);font-family:var(--dsh-font-family-code-default)}
.dim-rowEnd{z-index:1;flex:none;align-items:center;gap:var(--dim-space-2);display:inline-flex;position:relative}
.dim-dot{width:8px;height:8px;border-radius:50%;corner-shape:round;display:inline-block;flex:none;background:var(--dsw-alias-label-tertiary)}
.dim-dotOk{background:var(--dsw-alias-state-success-primary)}
.dim-dotWarn{background:var(--dsw-alias-state-warn-primary)}
.dim-dotErr{background:var(--dsw-alias-state-error-primary)}
.dim-log{box-sizing:border-box;width:100%;max-height:240px;overflow:auto;margin:0;padding:var(--dim-space-2) var(--dim-space-3);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;font:var(--dsw-font-xxs-12);font-family:var(--dsh-font-family-code-default)}
.dim-log:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dim-danger{color:var(--dsw-alias-state-error-primary)}
.dim-overlay{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1);display:flex;align-items:center;justify-content:center;z-index:3000;padding:var(--dim-space-6)}
.dim-dialog{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xl);padding:var(--dim-space-6);width:min(560px,100%);max-height:86vh;overflow:auto;display:flex;flex-direction:column;gap:var(--dim-space-4);box-shadow:var(--dsw-elevation-prominent)}
.dim-dialog:focus-visible{outline:none}
.dim-dialogHead{display:flex;align-items:center;justify-content:space-between;gap:var(--dim-space-3)}
.dim-dialogTitle{margin:0;overflow-wrap:anywhere;font:var(--dsw-font-base-strong-16)}
.dim-dialogBody{display:flex;flex-direction:column;gap:var(--dim-space-3);min-width:0}
.dim-footer{display:flex;justify-content:flex-end;gap:var(--dim-space-2);flex-wrap:wrap}
.dim-field{display:flex;flex-direction:column;gap:var(--dim-space-1);min-width:0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13)}
.dim-fieldHint{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.dim-fieldError{color:var(--dsw-alias-state-error-primary);margin:0;font:var(--dsw-font-xxs-12)}
.dim-select{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);height:34px;width:100%;color:var(--dsw-alias-label-primary);outline:none;padding:0 var(--dim-space-field);font:var(--dsw-font-xs-13);transition:border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.dim-select:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary)}
.dim-select[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}
.dim-qr{width:240px;height:240px;align-self:center;border-radius:var(--dsw-radius-md);display:block;object-fit:contain;background:#fff}
.dim-qrEmpty{width:240px;height:240px;align-self:center;display:flex;align-items:center;justify-content:center;text-align:center;padding:var(--dim-space-4);box-sizing:border-box;background:var(--dsw-alias-bg-layer-3);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13)}
.dim-qrState{margin:0;color:var(--dsw-alias-label-secondary);text-align:center;font:var(--dsw-font-xs-13)}
.dim-check{display:flex;flex-wrap:wrap;gap:var(--dim-space-3);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13)}
.dim-check label{display:inline-flex;align-items:center;gap:var(--dim-space-1)}
.dim-notice{border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);padding:var(--dim-space-2) var(--dim-space-3);display:flex;align-items:center;gap:var(--dim-space-2);font:var(--dsw-font-xs-13)}
.dim-notice span{flex:1;min-width:0;overflow-wrap:anywhere}
.dim-noticeErr{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,var(--dsw-alias-bg-layer-2))}
@media (prefers-reduced-motion: reduce){.dim-card,.dim-crumb,.dim-select{transition:none}}

`;

    function injectCss() {
      if (typeof document === 'undefined' || document === null) return;
      const id = 'dsh-im-manager/client.css';
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-im-manager';
      tag.dataset.pluginCss = id;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }
    injectCss();

    function createRpc(connection) {
      return async function rpc(endpoint, payload = {}) {
        const result = await connection.rpc.call('/im-manager', endpoint, payload);
        if (result === null || typeof result !== 'object') throw new Error('RPC returned no result');
        if (result.ok !== true) {
          const error = new Error(result.error?.message ?? 'RPC failed');
          error.code = result.error?.code;
          throw error;
        }
        return result.value;
      };
    }

    const dotClass = (state) => state === 'running' || state === 'connected' ? 'dim-dot dim-dotOk'
      : state === 'starting' || state === 'stopping' || state === 'scanned' || state === 'pending' || state === 'restarting' ? 'dim-dot dim-dotWarn'
        : state === 'error' || state === 'failed' || state === 'expired' ? 'dim-dot dim-dotErr'
          : 'dim-dot';

    // Version update: state lives on the host (persisted across HMR reloads);
    // the page only polls `update.state` while an install is in flight.
    const UPDATE_POLL_MS = 1500;
    const UPDATE_POLL_LIMIT = 200;
    const UPDATE_RESULT_TTL_MS = 24 * 60 * 60 * 1000;

    function updateNoticeFromState(state) {
      if (state === null || state === undefined) return null;
      if (state.status === 'installed') {
        return { tone: 'ok', text: `已更新到 v${state.latestVersion ?? ''}，刷新页面后生效`, reload: true };
      }
      if (state.status === 'restart_required') {
        return { tone: 'ok', text: `已安装 v${state.latestVersion ?? ''}，重启 DSH 后生效`, reload: false };
      }
      if (state.status === 'error') {
        return { tone: 'error', text: state.error?.message ?? state.message ?? '更新失败', reload: false };
      }
      return null;
    }

    function isRecentUpdateResult(state) {
      if (state === null || state === undefined) return false;
      const finished = Date.parse(state.finishedAt ?? state.checkedAt ?? '');
      if (Number.isFinite(finished) === false) return false;
      return Date.now() - finished <= UPDATE_RESULT_TTL_MS;
    }

    function StateLabel({ state }) {
      return h('span', { className: 'dim-state' }, h('span', { className: dotClass(state), 'aria-hidden': 'true' }), state);
    }

    function Tag({ children, tone }) {
      return h('span', { className: `dim-tag${tone === 'ok' ? ' dim-tagOk' : tone === 'err' ? ' dim-tagErr' : ''}` }, children);
    }

    function Dialog({ title, onClose, children, rect }) {
      const dialogRef = useRef(null);
      const restoreRef = useRef(null);
      const titleIdRef = useRef(null);
      if (titleIdRef.current === null) {
        dialogSeq += 1;
        titleIdRef.current = `dim-dialog-title-${dialogSeq}`;
      }
      const titleId = titleIdRef.current;
      // Modal contract: focus moves into the dialog when it opens and returns
      // to the trigger when it closes.
      useEffect(() => {
        if (typeof document === 'undefined' || document === null) return undefined;
        restoreRef.current = document.activeElement;
        const node = dialogRef.current;
        const first = node === null || node === undefined ? null : node.querySelector(FOCUSABLE);
        if (first !== null && first !== undefined && typeof first.focus === 'function') first.focus();
        return () => {
          const restore = restoreRef.current;
          if (restore !== null && restore !== undefined && typeof restore.focus === 'function' && restore.isConnected !== false) restore.focus();
        };
      }, []);
      const onKeyDown = (event) => {
        if (event.key === 'Escape' || event.key === 'Esc') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key !== 'Tab' || typeof document === 'undefined' || document === null) return;
        const node = dialogRef.current;
        if (node === null || node === undefined) return;
        const items = Array.from(node.querySelectorAll(FOCUSABLE));
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
          event.preventDefault();
          last.focus();
        } else if (event.shiftKey === false && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };
      return h('div', {
        className: 'dim-overlay',
        style: rect === null || rect === undefined
          ? null
          : {
            left: `${Math.max(0, rect.left)}px`,
            top: `${Math.max(0, rect.top)}px`,
            width: `${Math.max(0, rect.width)}px`,
            height: `${Math.max(0, rect.height)}px`,
            right: 'auto',
            bottom: 'auto',
            maxWidth: 'none',
            boxSizing: 'border-box',
          },
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose();
        },
        onKeyDown,
      }, h('div', {
        className: 'dim-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
        tabIndex: -1,
        ref: dialogRef,
      },
        h('div', { className: 'dim-dialogHead' },
          h('h3', { className: 'dim-dialogTitle', id: titleId }, title),
          h(Button, { variant: 'outline', size: 'sm', 'aria-label': '关闭弹窗', onClick: onClose }, '关闭'),
        ),
        children,
      ));
    }

    function Field({ label, hint, children }) {
      return h('label', { className: 'dim-field' }, h('span', null, label), children, hint ? h('span', { className: 'dim-fieldHint' }, hint) : null);
    }

    function workspacesEqual(previous, next) {
      if (previous === null || next === null) return previous === next;
      return JSON.stringify(previous) === JSON.stringify(next);
    }

    function entryKey(entry) {
      if (entry === null || entry === undefined) return null;
      if (entry.workspaceId !== undefined && entry.workspaceId !== null) return `dsh:${entry.workspaceId}`;
      return entry.managerId === null || entry.managerId === undefined ? null : `manager:${entry.managerId}`;
    }

    function findEntry(discovery, key) {
      if (discovery === null || key === null) return null;
      if (key.startsWith('dsh:')) {
        const workspaceId = key.slice(4);
        const found = (discovery.workspaces ?? []).find((entry) => entry.workspaceId === workspaceId);
        return found === undefined ? null : { ...found, kind: 'dsh' };
      }
      const managerId = key.slice(8);
      const found = (discovery.unlinked ?? []).find((entry) => entry.managerId === managerId);
      return found === undefined ? null : { ...found, kind: 'unlinked' };
    }

    function entryTitle(entry) {
      return entry?.title ?? entry?.name ?? entry?.workspaceDir ?? '';
    }

    function gatewayState(entry) {
      if (entry?.kind === 'dsh') return entry.gateway?.state ?? 'none';
      return entry?.state ?? 'none';
    }

    function managerIdOf(entry) {
      return entry?.managerId ?? null;
    }

    function ImManagerPage({ rpc }) {
      const [discovery, setDiscovery] = useState(null);
      const [selectedKey, setSelectedKey] = useState(null);
      const [view, setView] = useState('list');
      const [config, setConfig] = useState(null);
      const [logs, setLogs] = useState([]);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState('');
      const [modal, setModal] = useState(null);
      const [notice, setNotice] = useState('');
      const [updateInfo, setUpdateInfo] = useState(null);
      const [updateBusy, setUpdateBusy] = useState('');
      const [updateNotice, setUpdateNotice] = useState(null);
      const selectedKeyRef = useRef(null);
      const managerIdRef = useRef(null);
      const modalRef = useRef(false);
      const qrTimer = useRef(null);
      const updatePoll = useRef(null);
      const pageRef = useRef(null);
      const [panelRect, setPanelRect] = useState(null);
      selectedKeyRef.current = selectedKey;
      modalRef.current = modal !== null;

      const selectedEntry = discovery === null ? null : findEntry(discovery, selectedKey);
      const selectedManagerId = managerIdOf(selectedEntry);
      managerIdRef.current = selectedManagerId;

      const loadConfig = async (managerId) => {
        if (!managerId) {
          setConfig(null);
          return;
        }
        try {
          setConfig(await rpc('config.get', { id: managerId }));
        } catch (cause) {
          setError(cause.message);
        }
      };

      const loadLogs = async (managerId) => {
        if (!managerId) {
          setLogs([]);
          return;
        }
        try {
          const result = await rpc('logs', { id: managerId, lines: 200 });
          setLogs(Array.isArray(result.lines) ? result.lines : []);
        } catch (cause) {
          setLogs([`读取日志失败：${cause.message}`]);
        }
      };

      const discover = async (preferredKey) => {
        try {
          const result = await rpc('discover');
          setDiscovery(result);
          setError('');
          const wanted = preferredKey ?? selectedKeyRef.current;
          if (findEntry(result, wanted) === null) {
            const running = (result.workspaces ?? []).find((entry) => entry.gateway?.state === 'running');
            const firstDsh = running ?? (result.workspaces ?? [])[0];
            const firstUnlinked = (result.unlinked ?? [])[0];
            const next = firstDsh !== undefined ? `dsh:${firstDsh.workspaceId}` : (firstUnlinked === undefined ? null : `manager:${firstUnlinked.managerId}`);
            setSelectedKey(next);
          }
          return result;
        } catch (cause) {
          // Older host halves without `discover`: fall back to manager entries.
          try {
            const state = await rpc('state');
            const fallback = {
              workspaces: [],
              unlinked: (state.workspaces ?? []).map((entry) => ({
                managerId: entry.id,
                name: entry.name,
                workspaceDir: entry.workspaceDir,
                state: entry.state,
                bridge: entry.bridge,
                sessions: entry.sessions,
                autoStart: entry.autoStart,
                channels: entry.channels ?? [],
                error: entry.error ?? null,
              })),
            };
            setDiscovery(fallback);
            setError(`工作区发现不可用：${cause.message}`);
            const first = fallback.unlinked[0];
            setSelectedKey(first === undefined ? null : `manager:${first.managerId}`);
            return fallback;
          } catch {
            setError(cause.message);
            return null;
          }
        }
      };

      const refresh = (preferredKey) => discover(preferredKey);

      useEffect(() => {
        if (modal === null) {
          setPanelRect(null);
          return undefined;
        }
        let frame = null;
        let settle = null;
        const measure = () => {
          const rect = pageRef.current?.getBoundingClientRect();
          if (rect !== undefined && rect !== null && rect.width > 0 && rect.height > 0) {
            setPanelRect({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
          }
        };
        measure();
        frame = requestAnimationFrame(() => {
          measure();
          // The first modal render can precede flex/scroll settling after a
          // list→detail transition; measure once more after layout.
          settle = setTimeout(measure, 120);
        });
        let observer = null;
        if (typeof ResizeObserver !== 'undefined' && pageRef.current !== null) {
          observer = new ResizeObserver(measure);
          observer.observe(pageRef.current);
        }
        const onScroll = () => measure();
        window.addEventListener('resize', onScroll);
        window.addEventListener('scroll', onScroll, true);
        return () => {
          if (frame !== null) cancelAnimationFrame(frame);
          if (settle !== null) clearTimeout(settle);
          if (observer !== null) observer.disconnect();
          window.removeEventListener('resize', onScroll);
          window.removeEventListener('scroll', onScroll, true);
        };
      }, [modal]);

      useEffect(() => {
        discover().then((result) => {
          if (result === null) return;
          const running = (result.workspaces ?? []).find((entry) => entry.gateway?.state === 'running');
          const first = running ?? (result.workspaces ?? [])[0];
          const firstUnlinked = (result.unlinked ?? [])[0];
          const key = first !== undefined ? `dsh:${first.workspaceId}` : (firstUnlinked === undefined ? null : `manager:${firstUnlinked.managerId}`);
          setSelectedKey(key);
          const managerId = first?.managerId ?? firstUnlinked?.managerId ?? null;
          if (managerId) {
            void loadConfig(managerId);
            void loadLogs(managerId);
          }
        });
        const timer = setInterval(() => {
          if (!modalRef.current) void discover();
        }, 2500);
        return () => {
          clearInterval(timer);
          if (qrTimer.current) clearInterval(qrTimer.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      useEffect(() => {
        if (selectedManagerId) {
          void loadConfig(selectedManagerId);
          void loadLogs(selectedManagerId);
        } else {
          setConfig(null);
          setLogs([]);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [selectedKey, selectedManagerId]);

      useEffect(() => {
        if (view === 'detail' && discovery !== null && selectedEntry === null) setView('list');
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [view, discovery]);

      const run = async (label, operation, options = {}) => {
        setBusy(label);
        try {
          await operation();
          await discover(options.preferredKey);
          const managerId = options.managerId ?? managerIdRef.current;
          if (managerId) {
            await loadConfig(managerId);
            if (options.refreshLogs !== false) await loadLogs(managerId);
          }
        } catch (cause) {
          setError(cause.message);
        } finally {
          setBusy('');
        }
      };

      const workspaceAction = (action) => {
        if (!selectedManagerId) return;
        void run(action, () => rpc(`workspace.${action}`, { id: selectedManagerId }));
      };

      const toggleAutoStart = () => {
        if (!selectedManagerId) return;
        const current = selectedEntry?.gateway?.autoStart === true;
        void run('autoStart', () => rpc('workspace.update', { id: selectedManagerId, autoStart: !current }));
      };

      const startQrPoll = (managerId, channel) => {
        if (qrTimer.current) clearInterval(qrTimer.current);
        qrTimer.current = setInterval(async () => {
          try {
            const flow = await rpc('connect.get', { id: managerId, channel });
            setModal((current) => {
              if (!current || current.kind !== 'qr') return current;
              return { ...current, session: { ...current.session, flow, state: flow.state, error: flow.error?.message ?? '' } };
            });
            if (flow.state === 'confirmed') {
              if (qrTimer.current) clearInterval(qrTimer.current);
              qrTimer.current = null;
              setModal(null);
              setNotice(`${channel} 已启用`);
              await discover(selectedKeyRef.current);
              await loadConfig(managerId);
            } else if (['expired', 'failed', 'cancelled'].includes(flow.state)) {
              if (qrTimer.current) clearInterval(qrTimer.current);
              qrTimer.current = null;
            }
          } catch {
            // retry
          }
        }, 1500);
      };

      const beginQr = async (managerId, channel) => {
        setModal({ kind: 'qr', session: { channel, state: 'pending', error: '', flow: null } });
        try {
          const flow = await rpc('connect.begin', { id: managerId, channel });
          setModal((current) => {
            if (!current || current.kind !== 'qr') return current;
            return { ...current, session: { ...current.session, flow, state: flow.state ?? 'pending', error: '' } };
          });
          startQrPoll(managerId, channel);
        } catch (cause) {
          setModal((current) => {
            if (!current || current.kind !== 'qr') return current;
            return { ...current, session: { ...current.session, state: 'failed', error: cause.message } };
          });
        }
      };

      const closeQr = async () => {
        if (qrTimer.current) {
          clearInterval(qrTimer.current);
          qrTimer.current = null;
        }
        const session = modal?.kind === 'qr' ? modal.session : null;
        setModal(null);
        if (session && session.state !== 'confirmed' && managerIdRef.current) {
          try {
            await rpc('connect.cancel', { id: managerIdRef.current, channel: session.channel });
            setNotice('已取消，渠道未启用');
          } catch (cause) {
            setError(cause.message);
          }
          await discover(selectedKeyRef.current);
        }
      };

      const disableChannel = (channel) => {
        if (!config || !selectedManagerId) return;
        const current = config.channels?.[channel.id] ?? {};
        const nextConfig = { ...config, channels: { ...config.channels, [channel.id]: { ...current, enabled: false } } };
        setBusy(`toggle:${channel.id}`);
        Promise.resolve()
          .then(() => rpc('config.save', { id: selectedManagerId, config: nextConfig }))
          .then(() => discover(selectedKeyRef.current))
          .then(() => loadConfig(selectedManagerId))
          .then(() => setNotice(`${channel.name} 已停用`))
          .catch((cause) => setError(cause.message))
          .finally(() => setBusy(''));
      };

      const saveChannel = async (channel, form) => {
        if (!config || !selectedManagerId) return;
        const current = config.channels?.[channel.id] ?? {};
        const nextChannel = { ...current, enabled: true };
        for (const [key, value] of Object.entries(form)) {
          if (typeof value === 'string' && value.length > 0) nextChannel[key] = value;
        }
        const nextConfig = { ...config, channels: { ...config.channels, [channel.id]: nextChannel } };
        setBusy(`save:${channel.id}`);
        try {
          await rpc('config.save', { id: selectedManagerId, config: nextConfig });
          setModal(null);
          setNotice(`${channel.name} 已启用`);
          await discover(selectedKeyRef.current);
          await loadConfig(selectedManagerId);
        } catch (cause) {
          setError(cause.message);
        } finally {
          setBusy('');
        }
      };

      const adoptGateway = async (entry, start) => {
        setBusy(start ? 'adoptStart' : 'adopt');
        try {
          const created = await rpc('workspace.adopt', { path: entry.path, title: entry.title });
          if (start) await rpc('workspace.start', { id: created.id });
          await discover(entryKey(entry));
          await loadConfig(created.id);
          setNotice(start ? 'Gateway 已创建并启动' : 'Gateway 已创建；可在详情里配置渠道');
        } catch (cause) {
          setError(cause.message);
        } finally {
          setBusy('');
        }
      };

      const approvePairing = (entry) => {
        if (!selectedManagerId) return;
        void run('pair', () => rpc('pairing.approve', { id: selectedManagerId, code: entry.code }));
      };

      const addAllow = async (form) => {
        if (!selectedManagerId) return;
        setBusy('allow');
        try {
          await rpc('pairing.allow', { id: selectedManagerId, channel: form.channel, senderId: form.senderId, ...(form.name ? { name: form.name } : {}) });
          setModal(null);
          setNotice('已加入 allowlist');
          await discover(selectedKeyRef.current);
        } catch (cause) {
          setError(cause.message);
        } finally {
          setBusy('');
        }
      };

      const addExternalWorkspace = async (form) => {
        setBusy('add');
        try {
          const created = await rpc('workspace.add', { name: form.name, workspaceDir: form.dir, channels: form.channels, autoStart: false });
          await discover();
          setSelectedKey(`manager:${created.id}`);
          setView('detail');
          setModal(null);
          setNotice('外部工作区已创建');
        } catch (cause) {
          setError(cause.message);
        } finally {
          setBusy('');
        }
      };

      const removeBinding = async () => {
        if (modal?.kind !== 'confirm' || !modal.entry.managerId) return;
        const entry = modal.entry;
        setModal(null);
        await run('remove', () => rpc('workspace.remove', { id: entry.managerId }), { preferredKey: selectedKeyRef.current });
        setNotice('已移除 Gateway 绑定（DSH 工作区保留）');
      };

      const stopUpdatePoll = () => {
        if (updatePoll.current !== null) {
          clearInterval(updatePoll.current);
          updatePoll.current = null;
        }
      };

      const startUpdatePoll = () => {
        stopUpdatePoll();
        let ticks = 0;
        updatePoll.current = setInterval(async () => {
          ticks += 1;
          if (ticks > UPDATE_POLL_LIMIT) {
            stopUpdatePoll();
            setUpdateBusy('');
            setUpdateNotice({ tone: 'error', text: '安装状态超时，请重新检查更新', reload: false });
            return;
          }
          try {
            const value = await rpc('update.state');
            setUpdateInfo(value);
            const state = value?.state ?? null;
            if (state?.status === 'installing') return;
            stopUpdatePoll();
            setUpdateBusy('');
            const notice = updateNoticeFromState(state);
            if (notice !== null) setUpdateNotice(notice);
          } catch {
            // HMR reload can briefly break the route; retry on the next tick.
          }
        }, UPDATE_POLL_MS);
      };

      const checkUpdate = async () => {
        if (updateBusy !== '') return;
        stopUpdatePoll();
        setUpdateNotice(null);
        setUpdateBusy('check');
        try {
          const result = await rpc('update.check');
          setUpdateInfo(result);
          if (result?.hasUpdate !== true) {
            setUpdateBusy('');
            setUpdateNotice({ tone: 'ok', text: `已是最新版本（v${result?.currentVersion ?? ''}）`, reload: false });
            return;
          }
          setUpdateNotice({ tone: 'ok', text: `发现新版本 v${result.latestVersion}，正在自动下载安装…`, reload: false });
          setUpdateBusy('install');
          await rpc('update.install');
          startUpdatePoll();
        } catch (cause) {
          stopUpdatePoll();
          setUpdateBusy('');
          setUpdateNotice({ tone: 'error', text: cause.message, reload: false });
        }
      };

      useEffect(() => {
        let cancelled = false;
        rpc('update.state').then((value) => {
          if (cancelled) return;
          setUpdateInfo(value);
          const state = value?.state ?? null;
          if (state?.status === 'installing') {
            setUpdateBusy('install');
            if (typeof state.latestVersion === 'string') {
              setUpdateNotice({ tone: 'ok', text: `发现新版本 v${state.latestVersion}，正在自动下载安装…`, reload: false });
            }
            startUpdatePoll();
            return;
          }
          const notice = isRecentUpdateResult(state) ? updateNoticeFromState(state) : null;
          if (notice !== null) setUpdateNotice(notice);
        }).catch(() => {
          // Older host halves have no update endpoints; keep the page usable.
        });
        return () => {
          cancelled = true;
          stopUpdatePoll();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const updateBar = updateNotice === null ? null : h('div', {
        className: `dim-notice${updateNotice.tone === 'error' ? ' dim-noticeErr' : ''}`,
        role: 'status',
        'aria-live': 'polite',
      },
        h('span', null, updateNotice.text),
        updateNotice.reload
          ? h(Button, {
            variant: 'outline',
            size: 'sm',
            onClick: () => {
              if (typeof window !== 'undefined' && window.location !== undefined && typeof window.location.reload === 'function') {
                window.location.reload();
              }
            },
          }, '刷新页面')
          : null,
        h(Button, { variant: 'outline', size: 'sm', onClick: () => setUpdateNotice(null) }, '关闭'),
      );

      const versionSuffix = typeof updateInfo?.currentVersion === 'string' && updateInfo.currentVersion.length > 0
        ? ` · 当前版本 v${updateInfo.currentVersion}`
        : '';

      if (discovery === null) {
        return h('div', { className: 'dim-page', ref: pageRef },
          h('div', { className: 'dim-pageHead' },
            h('div', { className: 'dim-heading' },
              h('h1', { className: 'dim-title' }, '消息'),
              h('p', { className: 'dim-intro' }, '正在读取 DSH workspace 与 Gateway 状态…'),
            ),
          ),
          h('p', { className: error ? 'dim-failure' : 'dim-empty' }, error || ''),
        );
      }

      const workspaces = discovery.workspaces ?? [];
      const unlinked = discovery.unlinked ?? [];
      const runningCount = workspaces.filter((entry) => entry.gateway?.state === 'running').length;
      const managerEntry = selectedEntry;
      const pending = selectedEntry?.kind === 'dsh' ? (selectedEntry.gateway?.pendingPairings ?? []) : (selectedEntry?.pendingPairings ?? []);
      const channelList = selectedEntry?.kind === 'dsh' ? (selectedEntry.gateway?.channels ?? []) : (selectedEntry?.channels ?? []);

      const modalLayer = [
        modal?.kind === 'qr' ? h(QrDialog, { modal, rect: panelRect, onClose: closeQr, onRegenerate: () => beginQr(managerIdRef.current, modal.session.channel) }) : null,
        modal?.kind === 'channel' ? h(ChannelDialog, {
          channel: CHANNELS.find((entry) => entry.id === modal.channelId),
          config,
          rect: panelRect,
          busy: busy.startsWith('save:'),
          onClose: () => setModal(null),
          onSubmit: saveChannel,
        }) : null,
        modal?.kind === 'add' ? h(AddWorkspaceDialog, { busy: busy === 'add', rect: panelRect, onClose: () => setModal(null), onSubmit: addExternalWorkspace }) : null,
        modal?.kind === 'allow' ? h(AllowDialog, { busy: busy === 'allow', rect: panelRect, onClose: () => setModal(null), onSubmit: addAllow }) : null,
        modal?.kind === 'confirm' ? h(Dialog, { title: '移除 Gateway 绑定', rect: panelRect, onClose: () => setModal(null) },
          h('p', { className: 'dim-empty' }, `只删除 manager 里的 Gateway 绑定「${entryTitle(modal.entry)}」，DSH 工作区、磁盘文件和会话都会保留。`),
          h('div', { className: 'dim-footer' },
            h(Button, { variant: 'outline', size: 'sm', onClick: () => setModal(null) }, '取消'),
            h(Button, { variant: 'outline', size: 'sm', className: 'dim-danger', icon: h(IconTrashOutlineRegular, { size: 13 }), onClick: removeBinding }, '移除绑定'),
          ),
        ) : null,
      ];

      const banner = error
        ? h('div', { className: 'dim-notice dim-noticeErr', role: 'status', 'aria-live': 'polite' }, h('span', null, error), h(Button, { variant: 'outline', size: 'sm', onClick: () => setError('') }, '关闭'))
        : notice
          ? h('div', { className: 'dim-notice', role: 'status', 'aria-live': 'polite' }, h('span', null, notice), h(Button, { variant: 'outline', size: 'sm', onClick: () => setNotice('') }, '关闭'))
          : null;

      const workspaceRow = (entry, key) => {
        const state = entry.kind === 'dsh' ? (entry.gateway?.state ?? 'none') : entry.state;
        const channels = entry.kind === 'dsh' ? (entry.gateway?.channels ?? []) : (entry.channels ?? []);
        const sessions = entry.kind === 'dsh' ? (entry.gateway?.sessions ?? 0) : (entry.sessions ?? 0);
        return h('li', { key, className: 'dim-card' },
          h('div', {
            className: 'dim-cardHead dim-cardHeadClick',
            role: 'button',
            tabIndex: 0,
            onClick: () => {
              setSelectedKey(key);
              setView('detail');
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                event.preventDefault();
                setSelectedKey(key);
                setView('detail');
              }
            },
          },
            h('span', { className: 'dim-cardIcon' }, h(WorkspaceIcon)),
            h('div', { className: 'dim-cardMain' },
              h('div', { className: 'dim-titleRow' },
                h('span', { className: 'dim-cardTitle' }, entryTitle(entry)),
                state === 'none'
                  ? h('span', { className: 'dim-tag' }, '未创建 Gateway')
                  : h(StateLabel, { state }),
                entry.kind === 'dsh' ? null : h('span', { className: 'dim-tag' }, 'Manager 条目'),
                (entry.gateway?.autoStart ?? entry.autoStart) ? h('span', { className: 'dim-tag' }, '自动启动') : null,
              ),
              h('div', { className: 'dim-cardDesc' }, entry.path ?? entry.workspaceDir ?? ''),
              h('div', { className: 'dim-cardMeta' }, `${entry.kind === 'dsh' ? (entry.managerId ?? 'no-gateway') : `manager:${entry.managerId}`} · ${channels.length > 0 ? channels.map((channel) => `${channel.id}:${channel.health || '?'}`).join('  ') : '未启用渠道'} · sessions ${sessions}`),
            ),
            h('span', { className: 'dim-cardEnd' }, h(IconChevronRightOutlineRegular, { size: 16, className: 'dim-chevron' })),
          ),
        );
      };

      if (view === 'list') {
        return h('div', { className: 'dim-page', ref: pageRef },
          h('div', { className: 'dim-pageHead' },
            h('div', { className: 'dim-heading' },
              h('h1', { className: 'dim-title' }, '消息'),
              h('p', { className: 'dim-intro' }, `当前 profile 的 DSH 工作区 · ${runningCount}/${workspaces.length} 个 Gateway 运行中${versionSuffix}`),
            ),
            h('div', { className: 'dim-toolbar' },
              h(Button, { variant: 'outline', size: 'sm', icon: h(IconRefreshOutlineRegular, { size: 13 }), onClick: () => discover() }, '刷新'),
              h(Button, { variant: 'outline', size: 'sm', disabled: updateBusy !== '', icon: h(IconRefreshOutlineRegular, { size: 13 }), onClick: () => { void checkUpdate(); } }, updateBusy === 'check' ? '检查中…' : updateBusy === 'install' ? '安装中…' : '检查更新'),
              h(Button, { variant: 'primary', size: 'sm', icon: h(IconPlusOutlineRegular, { size: 13 }), onClick: () => setModal({ kind: 'add' }) }, '添加外部工作区'),
            ),
          ),
          banner,
          updateBar,
          h('div', { className: 'dim-group' },
            h('div', { className: 'dim-groupHead' },
              h('h3', { className: 'dim-groupTitle' }, 'DSH 工作区'),
              h('span', { className: 'dim-groupCount' }, `${workspaces.length} 个`),
            ),
            workspaces.length === 0
              ? h('p', { className: 'dim-emptyState' }, '当前 profile 还没有 DSH 工作区；先在 DSH 侧栏添加工作区。')
              : h('ul', { className: 'dim-cards' }, ...workspaces.map((entry) => workspaceRow({ ...entry, kind: 'dsh' }, `dsh:${entry.workspaceId}`))),
          ),
          unlinked.length > 0
            ? h('div', { className: 'dim-group' },
              h('div', { className: 'dim-groupHead' },
                h('h3', { className: 'dim-groupTitle' }, '其他 Gateway 条目'),
                h('span', { className: 'dim-groupCount' }, `${unlinked.length} 个 · 不属于当前 profile 的 DSH 工作区`),
              ),
              h('ul', { className: 'dim-cards' }, ...unlinked.map((entry) => workspaceRow({ ...entry, kind: 'unlinked' }, `manager:${entry.managerId}`))),
            )
            : null,
          modalLayer,
        );
      }

      if (managerEntry === null) {
        return h('div', { className: 'dim-page dim-detail', ref: pageRef },
          h('div', { className: 'dim-detailTop' },
            h('button', { className: 'dim-crumb', onClick: () => setView('list') }, h(IconChevronLeftOutlineMedium, { size: 14 }), ' 消息'),
          ),
          h('p', { className: 'dim-emptyState' }, '工作区已不存在，返回列表。'),
          updateBar,
          modalLayer,
        );
      }

      const state = gatewayState(managerEntry);
      const hasGateway = managerEntry.managerId !== null && managerEntry.managerId !== undefined;
      const autoStart = managerEntry.kind === 'dsh' ? managerEntry.gateway?.autoStart === true : managerEntry.autoStart === true;
      const bridge = managerEntry.kind === 'dsh' ? (managerEntry.gateway?.bridge ?? 'absent') : (managerEntry.bridge ?? 'absent');
      const sessions = managerEntry.kind === 'dsh' ? (managerEntry.gateway?.sessions ?? 0) : (managerEntry.sessions ?? 0);
      const httpPort = managerEntry.kind === 'dsh' ? (managerEntry.gateway?.http?.port ?? '—') : '—';

      return h('div', { className: 'dim-page dim-detail', ref: pageRef },
        h('div', { className: 'dim-detailTop' },
          h('button', { className: 'dim-crumb', onClick: () => setView('list') }, h(IconChevronLeftOutlineMedium, { size: 14 }), ' 消息'),
        ),
        banner,
        updateBar,
        h('div', { className: 'dim-detailHead' },
          h('h1', { className: 'dim-detailTitle' }, entryTitle(managerEntry)),
          h('div', { className: 'dim-toolbar' },
            hasGateway
              ? h(Button, { variant: 'outline', size: 'sm', disabled: busy === 'start' || state === 'running', onClick: () => workspaceAction('start') }, busy === 'start' ? '启动中…' : '开始')
              : null,
            hasGateway
              ? h(Button, { variant: 'outline', size: 'sm', disabled: busy === 'stop' || state !== 'running', onClick: () => workspaceAction('stop') }, busy === 'stop' ? '停止中…' : '停止')
              : null,
            hasGateway
              ? h(Button, { variant: 'outline', size: 'sm', disabled: busy === 'restart', onClick: () => workspaceAction('restart') }, busy === 'restart' ? '重启中…' : '重启')
              : null,
            !hasGateway && managerEntry.kind === 'dsh'
              ? h(Button, { variant: 'primary', size: 'sm', disabled: busy === 'adopt', icon: h(IconPlusOutlineRegular, { size: 13 }), onClick: () => adoptGateway(managerEntry, false) }, busy === 'adopt' ? '创建中…' : '创建 Gateway')
              : null,
            !hasGateway && managerEntry.kind === 'dsh'
              ? h(Button, { variant: 'outline', size: 'sm', disabled: busy === 'adoptStart', onClick: () => adoptGateway(managerEntry, true) }, busy === 'adoptStart' ? '创建中…' : '创建并启动')
              : null,
            hasGateway
              ? h(Button, { variant: 'outline', size: 'sm', disabled: busy === 'autoStart', onClick: toggleAutoStart }, autoStart ? '关闭自动启动' : '开启自动启动')
              : null,
            hasGateway
              ? h(Button, { variant: 'outline', size: 'sm', className: 'dim-danger', icon: h(IconTrashOutlineRegular, { size: 13 }), disabled: busy === 'remove', onClick: () => setModal({ kind: 'confirm', entry: managerEntry }) }, '移除绑定')
              : null,
          ),
        ),
        h('div', { className: 'dim-detailMain' },
          h('p', { className: 'dim-detailDesc' }, managerEntry.path ?? managerEntry.workspaceDir ?? ''),
          h('p', { className: 'dim-detailMeta' }, `manager: ${managerEntry.managerId ?? '—'} · bridge: ${bridge} · 会话: ${sessions} · HTTP: ${httpPort}`),
          managerEntry.error ? h('p', { className: 'dim-failure' }, managerEntry.error) : null,
        ),
        !hasGateway && managerEntry.kind === 'dsh'
          ? h('div', { className: 'dim-detailSections' },
            h('div', { className: 'dim-section' },
              h('h3', { className: 'dim-sectionTitle' }, 'Gateway'),
              h('p', { className: 'dim-empty' }, '这个 DSH 工作区还没有 IM Gateway。创建后会生成该工作区的 `.dsh-im-manager/config.json`，渠道默认未启用；可以再逐个配置飞书/钉钉/企微/微信。'),
              h('div', { className: 'dim-toolbar' },
                h(Button, { variant: 'primary', size: 'sm', disabled: busy === 'adopt', icon: h(IconPlusOutlineRegular, { size: 13 }), onClick: () => adoptGateway(managerEntry, false) }, '创建 Gateway'),
                h(Button, { variant: 'outline', size: 'sm', disabled: busy === 'adoptStart', onClick: () => adoptGateway(managerEntry, true) }, '创建并启动'),
              ),
            ),
          )
          : h('div', { className: 'dim-detailSections' },
            h('div', { className: 'dim-section' },
              h('div', { className: 'dim-sectionHead' },
                h('h3', { className: 'dim-sectionTitle' }, '渠道'),
                h('span', { className: 'dim-sectionCount' }, '扫码或填写凭据启用'),
              ),
              h('ul', { className: 'dim-rows' }, ...CHANNELS.map((channel) => {
                const saved = config?.channels?.[channel.id] ?? null;
                const enabled = saved?.enabled === true;
                const health = channelList.find((entry) => entry.id === channel.id)?.health ?? '';
                return h('li', { key: channel.id, className: 'dim-row' },
                  h('span', { className: 'dim-rowIcon' }, h(ChannelIcon, { id: channel.id })),
                  h('div', { className: 'dim-rowMain' },
                    h('span', { className: 'dim-rowId' }, channel.name),
                    h('span', { className: 'dim-rowDesc' }, enabled ? (health || '已启用') : '未启用'),
                  ),
                  h('div', { className: 'dim-rowEnd' },
                    channel.config
                      ? h(Button, { variant: 'outline', size: 'sm', disabled: busy === `save:${channel.id}`, onClick: () => setModal({ kind: 'channel', channelId: channel.id }) }, enabled ? '编辑配置' : (channel.qr ? '手动配置' : '配置并启用'))
                      : null,
                    channel.qr && !enabled
                      ? h(Button, { variant: 'primary', size: 'sm', onClick: () => beginQr(selectedManagerId, channel.id) }, '扫码启用')
                      : null,
                    enabled
                      ? h(Button, { variant: 'outline', size: 'sm', disabled: busy === `toggle:${channel.id}`, onClick: () => disableChannel(channel) }, '停用')
                      : null,
                  ),
                );
              })),
            ),
            h('div', { className: 'dim-section' },
              h('div', { className: 'dim-sectionHead' },
                h('h3', { className: 'dim-sectionTitle' }, '配对请求'),
                h(Button, { variant: 'outline', size: 'sm', onClick: () => setModal({ kind: 'allow' }) }, '直接 allow'),
              ),
              pending.length === 0
                ? h('p', { className: 'dim-emptyState' }, '暂无待配对请求。新用户私聊机器人后，这里会出现配对码。')
                : h('ul', { className: 'dim-rows' }, ...pending.map((entry) => h('li', { key: `${entry.channel}:${entry.senderId}`, className: 'dim-row' },
                  h('span', { className: 'dim-rowIcon' }, h(ChannelIcon, { id: entry.channel })),
                  h('div', { className: 'dim-rowMain' },
                    h('span', { className: 'dim-rowId' }, `${entry.channel}:${entry.senderId}`),
                    h('span', { className: 'dim-rowDesc' }, `配对码 ${entry.code}${entry.name ? ` · ${entry.name}` : ''}`),
                  ),
                  h('div', { className: 'dim-rowEnd' }, h(Button, { variant: 'primary', size: 'sm', onClick: () => approvePairing(entry) }, '批准')),
                ))),
            ),
            h('div', { className: 'dim-section' },
              h('div', { className: 'dim-sectionHead' },
                h('h3', { className: 'dim-sectionTitle' }, '最近日志'),
                h(Button, { variant: 'outline', size: 'sm', icon: h(IconRefreshOutlineRegular, { size: 13 }), onClick: () => loadLogs(selectedManagerId) }, '刷新'),
              ),
              h('pre', { className: 'dim-log', tabIndex: 0, role: 'region', 'aria-label': '最近日志' }, logs.length > 0 ? logs.slice(-200).join('\n') : '（暂无日志）'),
            ),
          ),
        modalLayer,
      );
    }

    function WorkspaceIcon() {
      return h('svg', {
        width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      }, h('path', { d: 'M4 5.5h16v10H9l-5 4z' }), h('path', { d: 'M8 9.5h8M8 12.5h5' }));
    }

    function ChannelIcon({ id }) {
      const props = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' };
      if (id === 'feishu') return h('svg', props, h('path', { d: 'M21 3 3 10l6 2 2 6 3-4 4 3z' }));
      if (id === 'dingtalk') return h('svg', props, h('path', { d: 'M13 2 4 14h6l-1 8 9-12h-6z' }));
      if (id === 'wecom') return h('svg', props, h('path', { d: 'M4 20V6a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v14z' }), h('path', { d: 'M17 9h2a1 1 0 0 1 1 1v10h-3M8 8h5M8 12h5' }));
      return h('svg', props, h('path', { d: 'M21 11a8 8 0 0 1-11.6 7.1L4 20l1.9-5.4A8 8 0 1 1 21 11z' }), h('path', { d: 'M8 11h.01M12 11h.01M16 11h.01' }));
    }

    function QrDialog({ modal, onClose, onRegenerate, rect }) {
      const session = modal.session;
      const qr = session.flow?.qr ?? null;
      const terminal = ['expired', 'failed', 'cancelled'].includes(session.state);
      const stateText = {
        pending: '等待扫码…',
        scanned: '已扫码，请在手机上确认',
        confirmed: '已确认',
        expired: '二维码已过期',
        failed: '连接失败',
        cancelled: '已取消',
      }[session.state] ?? session.state;
      return h(Dialog, { title: `连接${session.channel}`, rect, onClose },
        h('p', { className: 'dim-empty' }, '用手机扫描二维码并在手机上确认。关闭弹窗会取消并保持渠道未启用。'),
        qr?.dataUrl ? h('img', { src: qr.dataUrl, alt: '登录二维码', className: 'dim-qr' })
          : h('div', { className: 'dim-qrEmpty', role: 'status', 'aria-live': 'polite' }, session.error || '正在生成二维码…'),
        h(StateLabel, { state: session.state }),
        h('p', { className: 'dim-qrState', role: 'status', 'aria-live': 'polite' }, stateText),
        terminal ? h('div', { className: 'dim-footer' }, h(Button, { variant: 'primary', size: 'sm', onClick: onRegenerate }, '重新生成二维码')) : null,
        h('div', { className: 'dim-footer' }, h(Button, { variant: 'outline', size: 'sm', onClick: onClose }, '取消并关闭')),
      );
    }

    function ChannelDialog({ channel, config, busy, onClose, onSubmit, rect }) {
      const current = config?.channels?.[channel.id] ?? {};
      const fields = FIELDS[channel.id] ?? [];
      const [values, setValues] = useState(() => {
        const initial = {};
        for (const field of fields) initial[field.key] = field.secret ? '' : (current[field.key] ?? '');
        return initial;
      });
      const setValue = (key, value) => setValues((previous) => ({ ...previous, [key]: value }));
      return h(Dialog, { title: `${channel.name}配置`, rect, onClose },
        h('p', { className: 'dim-empty' }, '保存后会启用该渠道；密钥留空表示保留已保存的值。'),
        ...fields.map((field) => h(Field, {
          key: field.key,
          label: field.label,
          hint: field.secret && current[field.key] === '***' ? '已保存，留空不改' : undefined,
        }, field.type === 'select'
          ? h('select', { className: 'dim-select', value: values[field.key], onChange: (event) => setValue(field.key, event.target.value) }, ...field.options.map(([value, label]) => h('option', { key: value, value }, label)))
          : h(Input, {
            type: field.secret ? 'password' : 'text',
            value: values[field.key],
            placeholder: field.placeholder ?? '',
            onChange: (event) => setValue(field.key, event.target.value),
          }))),
        h('div', { className: 'dim-footer' },
          h(Button, { variant: 'outline', size: 'sm', onClick: onClose }, '取消'),
          h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => onSubmit(channel, values) }, busy ? '保存中…' : '保存并启用'),
        ),
      );
    }

    function AddWorkspaceDialog({ busy, onClose, onSubmit, rect }) {
      const [name, setName] = useState('');
      const [dir, setDir] = useState('');
      const [channels, setChannels] = useState([]);
      const toggle = (id) => setChannels((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
      return h(Dialog, { title: '添加工作区', rect, onClose },
        h('p', { className: 'dim-empty' }, '会创建 <workspaceDir>/.dsh-im-manager/config.json；所有渠道默认未启用。'),
        h(Field, { label: '名称' }, h(Input, { value: name, onChange: (event) => setName(event.target.value) })),
        h(Field, { label: '工作区目录（绝对路径）' }, h(Input, { value: dir, placeholder: '/Users/you/project', onChange: (event) => setDir(event.target.value) })),
        h('div', { className: 'dim-check' }, ...CHANNELS.map((channel) => h('label', { key: channel.id }, h('input', { type: 'checkbox', checked: channels.includes(channel.id), onChange: () => toggle(channel.id) }), channel.name))),
        h('div', { className: 'dim-footer' },
          h(Button, { variant: 'outline', size: 'sm', onClick: onClose }, '取消'),
          h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => onSubmit({ name, dir, channels }) }, busy ? '创建中…' : '创建'),
        ),
      );
    }

    function AllowDialog({ busy, onClose, onSubmit, rect }) {
      const [channel, setChannel] = useState('feishu');
      const [senderId, setSenderId] = useState('');
      const [name, setName] = useState('');
      return h(Dialog, { title: '直接加入 allowlist', rect, onClose },
        h(Field, { label: '渠道' }, h('select', { className: 'dim-select', value: channel, onChange: (event) => setChannel(event.target.value) }, ...CHANNELS.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name)))),
        h(Field, { label: 'Sender ID' }, h(Input, { value: senderId, placeholder: 'ou_… / wxid_…', onChange: (event) => setSenderId(event.target.value) })),
        h(Field, { label: '备注名（可选）' }, h(Input, { value: name, onChange: (event) => setName(event.target.value) })),
        h('div', { className: 'dim-footer' },
          h(Button, { variant: 'outline', size: 'sm', onClick: onClose }, '取消'),
          h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => onSubmit({ channel, senderId, name }) }, '加入'),
        ),
      );
    }

    function ImManagerIcon({ size = 16 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      }, h('path', { d: 'M4 5.5h16v10H9l-5 4z' }), h('path', { d: 'M8 9.5h8M8 12.5h5' }));
    }

    const inject = ['slots', 'connection', 'sessions'];
    const SESSION_REFRESH_INTERVAL_MS = 2000;

    async function apply(ctx) {
      const rpc = createRpc(ctx.connection);
      const Page = () => h(ImManagerPage, { rpc });

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: () => '消息' }, ImManagerIcon));
      ctx.slots.inject('main', function* registerMain() {
        yield ctx.slots.register({ name: 'main', key: PANEL_ID }, Page);
      });

      // IM traffic can create/replace sessions in the separate gateway runtime.
      // The Host session list is persisted-backed; refresh the client list when
      // the manager reports new binding activity so the sidebar picks them up
      // under the matching workspace, without a manual reload.
      const refreshSessionList = async () => {
        if (typeof ctx.sessions?.refresh !== 'function') return;
        try {
          await ctx.sessions.refresh();
        } catch {
          // A host generation transition can reject a refresh; the next tick retries.
        }
      };
      let lastRevision = null;
      let settleTimer = null;
      const tick = async () => {
        try {
          const activity = await rpc('activity');
          const revision = typeof activity?.revision === 'string' ? activity.revision : '';
          if (lastRevision !== null && revision !== lastRevision) {
            await refreshSessionList();
            // The gateway creates the persisted session just after binding the
            // conversation; one delayed refresh covers that small window.
            if (settleTimer !== null) clearTimeout(settleTimer);
            settleTimer = setTimeout(() => {
              settleTimer = null;
              void refreshSessionList();
            }, 1500);
          }
          lastRevision = revision;
        } catch {
          // manager not ready/attach race: retry on the next tick.
        }
      };
      void tick();
      const timer = setInterval(() => {
        void tick();
      }, SESSION_REFRESH_INTERVAL_MS);
      ctx.effect(() => () => {
        clearInterval(timer);
        if (settleTimer !== null) clearTimeout(settleTimer);
      }, 'im-manager: session list refresh');
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
