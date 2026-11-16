// The plugin's Settings section: the four values the runtime reads on each
// cycle. Values are volatile Config fields, so a save updates the profile
// override layer and the running plugin picks the new value up without a restart.
window.__ModuleLoader__.load({
  id: 'dsh-troubleshooting',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useMemo, useState, useSyncExternalStore } = React;

    const NS = 'troubleshootingSettings';
    // The slot may inject `t` from the registration locale; keep a bound fallback so
    // an older shell that does not still renders real labels instead of blanks.
    let fallbackT = key => key;

    const dictionaries = {
      zh: {
        sectionLabel: '智能故障定位',
        sectionTitle: '运行参数',
        sectionDescription: '轮询间隔、知识源路径、代码同步和群白名单；保存后生效。',
        browserChecking: '部署后台：正在读取 BrowserSkill 状态…',
        browserReady: '部署后台：BrowserSkill 已接入，可登录、浏览并核对后台页面。',
        browserMissing: '部署后台：未启用浏览器能力',
        browserUnknown: '部署后台：无法读取运行状态。',
        loading: '正在读取配置…',
        unavailable: '当前 profile 不提供这个插件的配置表单。',
        readonly: '当前 profile 不接受写入，请在 cordis.patch.yml 中修改。',
        pollInterval: '轮询间隔（秒）',
        knowledgePath: '知识源路径（文件或目录）',
        invalidPath: '请填写绝对路径（以 / 开头，或 Windows 盘符路径）',
        repositorySync: '排障前自动同步代码',
        chatGroupIds: '群白名单（逗号分隔）',
        save: '保存',
        reset: '恢复默认',
        saved: '已保存，下一次轮询或下一轮对话生效。',
        refused: '未保存：可能被更高优先级的配置覆盖。',
        failed: '保存失败：',
        invalidNumber: '请填 1 以上的整数',
        invalidRange: '超出允许范围：轮询 5–600 秒',
        invalidGroups: '至少填一个群 ID',
        unchanged: '没有改动',
      },
      en: {
        sectionLabel: 'Smart fault localization',
        sectionTitle: 'Runtime settings',
        sectionDescription: 'Poll interval, knowledge source, code sync, and group allowlist.',
        browserChecking: 'Deployment backend: reading BrowserSkill status…',
        browserReady: 'Deployment backend: BrowserSkill is connected; sign in, browse, and cross-check backend pages.',
        browserMissing: 'Deployment backend: browser capability is unavailable',
        browserUnknown: 'Deployment backend: could not read runtime status.',
        loading: 'Reading configuration…',
        unavailable: 'This profile does not expose a configuration form for this plugin.',
        readonly: 'This profile does not accept writes; edit cordis.patch.yml instead.',
        pollInterval: 'Poll interval (seconds)',
        knowledgePath: 'Knowledge source path (file or directory)',
        invalidPath: 'Enter an absolute path (starting with / or a Windows drive).',
        repositorySync: 'Sync code before each turn',
        chatGroupIds: 'Group allowlist (comma separated)',
        save: 'Save',
        reset: 'Reset to default',
        saved: 'Saved. It applies on the next poll or turn.',
        refused: 'Not saved: a higher-priority configuration may override it.',
        failed: 'Save failed: ',
        invalidNumber: 'Enter a whole number of 1 or more',
        invalidRange: 'Out of range: poll 5–600s',
        invalidGroups: 'Enter at least one group ID',
        unchanged: 'Nothing changed',
      },
    };

    const inputStyle = {
      width: '100%', boxSizing: 'border-box', height: 34, padding: '0 10px', font: 'inherit',
      color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l4)', borderRadius: 8, outline: 'none',
    };
    const labelStyle = { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' };
    const rowStyle = { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' };
    const buttonStyle = { font: 'inherit', fontSize: 13, padding: '6px 14px', borderRadius: 8, cursor: 'pointer' };
    const primaryStyle = {
      ...buttonStyle, border: '1px solid var(--dsw-alias-state-business-primary)',
      background: 'var(--dsw-alias-state-business-primary)', color: '#fff',
    };
    const secondaryStyle = {
      ...buttonStyle, border: '1px solid var(--dsw-alias-border-l3)',
      background: 'transparent', color: 'var(--dsw-alias-label-primary)',
    };
    const noteStyle = { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' };

    const draftOf = (value, knowledgeDefault = '') => ({
      pollSeconds: value?.pollIntervalMs === undefined ? '' : String(Math.round(Number(value.pollIntervalMs) / 1000)),
      knowledgePath: typeof value?.knowledgePath === 'string' ? value.knowledgePath : (knowledgeDefault || ''),
      repositorySync: value?.repositorySync !== false,
      groups: Array.isArray(value?.chatGroupIds) ? value.chatGroupIds.join(', ') : '',
    });

    const parseGroups = text => String(text ?? '').split(',').map(item => item.trim()).filter(Boolean);
    const parsePositive = text => {
      const number = Number(String(text ?? '').trim());
      return Number.isInteger(number) && number > 0 ? number : undefined;
    };

    function useDraft(form, knowledgeDefault) {
      const [draft, setDraft] = useState(() => draftOf(form?.state.value, knowledgeDefault));
      const revision = form?.state.revision;
      useEffect(() => { setDraft(draftOf(form?.state.value, knowledgeDefault)); }, [revision, knowledgeDefault]);
      return [draft, setDraft];
    }

    function SettingsCard(props) {
      const t = props.t ?? fallbackT;
      const form = props.form;
      const [draft, setDraft] = useDraft(form, props.knowledgeDefault);
      const [message, setMessage] = useState({ kind: 'idle', text: '' });
      const [busy, setBusy] = useState(false);

      const state = form?.state;
      const current = useMemo(() => draftOf(state?.value, props.knowledgeDefault), [state?.revision, state?.value, props.knowledgeDefault]);
      const status = state?.status ?? 'loading';

      if (status !== 'ready') {
        return h('p', { style: noteStyle }, status === 'unavailable' ? t('unavailable') : t('loading'));
      }

      const writable = state.writable !== false;
      const user = state.user && typeof state.user === 'object' ? state.user : {};
      const canReset = ['pollIntervalMs', 'knowledgePath', 'chatGroupIds', 'repositorySync'].some(key => Object.hasOwn(user, key));
      const dirty = ['pollSeconds', 'knowledgePath', 'groups', 'repositorySync'].some(key => draft[key] !== current[key]);

      const update = (key, text) => { setDraft({ ...draft, [key]: text }); setMessage({ kind: 'idle', text: '' }); };

      const save = async () => {
        const ops = [];
        // Only changed fields are submitted, so an empty or inherited field elsewhere
        // never blocks an unrelated edit.
        if (draft.pollSeconds !== current.pollSeconds) {
          const seconds = parsePositive(draft.pollSeconds);
          if (seconds === undefined || seconds < 5 || seconds > 600) { setMessage({ kind: 'error', text: t('invalidRange') }); return; }
          ops.push({ op: 'set', path: ['pollIntervalMs'], value: seconds * 1000 });
        }
        if (draft.knowledgePath !== current.knowledgePath) {
          const value = draft.knowledgePath.trim();
          if (!value || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)) { setMessage({ kind: 'error', text: t('invalidPath') }); return; }
          ops.push({ op: 'set', path: ['knowledgePath'], value });
        }
        if (draft.repositorySync !== current.repositorySync) {
          ops.push({ op: 'set', path: ['repositorySync'], value: draft.repositorySync });
        }
        if (draft.groups !== current.groups) {
          const groups = parseGroups(draft.groups);
          if (!groups.length) { setMessage({ kind: 'error', text: t('invalidGroups') }); return; }
          ops.push({ op: 'set', path: ['chatGroupIds'], value: groups });
        }
        if (!ops.length) { setMessage({ kind: 'idle', text: t('unchanged') }); return; }
        setBusy(true);
        try {
          const accepted = await form.mutate(ops, state.revision);
          setMessage(accepted ? { kind: 'ok', text: t('saved') } : { kind: 'error', text: t('refused') });
        } catch (error) {
          setMessage({ kind: 'error', text: t('failed') + (error?.message ?? String(error)) });
        } finally { setBusy(false); }
      };

      const reset = async () => {
        const ops = ['pollIntervalMs', 'knowledgePath', 'chatGroupIds', 'repositorySync']
          .filter(key => Object.hasOwn(user, key)).map(key => ({ op: 'unset', path: [key] }));
        if (!ops.length) return;
        setBusy(true);
        try {
          const accepted = await form.mutate(ops, state.revision);
          setMessage(accepted ? { kind: 'ok', text: t('saved') } : { kind: 'error', text: t('refused') });
        } catch (error) {
          setMessage({ kind: 'error', text: t('failed') + (error?.message ?? String(error)) });
        } finally { setBusy(false); }
      };

      const field = (key, label, inputProps) => h('label', { style: labelStyle, htmlFor: `troubleshooting-${key}` },
        label,
        h('input', { id: `troubleshooting-${key}`, style: inputStyle, value: draft[key], disabled: !writable, ...inputProps, onChange: event => update(key, event.target.value) }));

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560, paddingBottom: 8 } },
        !writable ? h('p', { style: noteStyle }, t('readonly')) : null,
        field('pollSeconds', t('pollInterval'), { inputMode: 'numeric', 'aria-invalid': false }),
        field('knowledgePath', t('knowledgePath'), { placeholder: '/absolute/path/to/knowledge.md' }),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } },
          h('input', { type: 'checkbox', checked: draft.repositorySync, disabled: !writable, onChange: event => update('repositorySync', event.target.checked) }),
          t('repositorySync')),
        field('groups', t('chatGroupIds'), { placeholder: 'qa-test' }),
        h('div', { style: rowStyle },
          h('button', { type: 'button', style: primaryStyle, disabled: !writable || busy || !dirty, onClick: save }, t('save')),
          h('button', { type: 'button', style: secondaryStyle, disabled: !writable || busy || !canReset, onClick: reset }, t('reset')),
          message.text ? h('span', {
            role: 'status',
            style: { ...noteStyle, color: message.kind === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)' },
          }, message.text) : null));
    }

    // The Settings page section reads the namespace through the settings service,
    // which shares the Host write queue with any other editor of this entry.
    function SettingsSectionPanel(props) {
      const t = props.t ?? fallbackT;
      const configForms = props.configForms;
      const form = useMemo(
        () => (configForms ? configForms.get('test-troubleshooting') : undefined),
        [configForms],
      );
      const subscribe = useMemo(
        () => (form ? callback => form.subscribe(callback) : () => {}),
        [form],
      );
      const state = useSyncExternalStore(
        subscribe,
        () => form?.getSnapshot(),
        () => form?.getSnapshot(),
      );
      const [runtime, setRuntime] = useState({ loading: true });
      useEffect(() => {
        let live = true;
        void fetch('/troubleshooting/status', { headers: { accept: 'application/json' } })
          .then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
          .then(data => { if (live) setRuntime({ loading: false, ...data }); })
          .catch(error => { if (live) setRuntime({ loading: false, error: error.message }); });
        return () => { live = false; };
      }, []);
      if (!form) return h('p', { style: noteStyle }, t('unavailable'));
      const browserStatus = runtime.loading ? t('browserChecking')
        : runtime.error ? t('browserUnknown')
        : runtime.deploymentBackend ? t('browserReady')
        : runtime.browserError ? `${t('browserMissing')}：${runtime.browserError}` : t('browserMissing');
      const adapter = { state, mutate: (ops, revision) => form.mutate(ops, revision) };
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560, paddingBottom: 8 } },
        h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('sectionTitle')),
        h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('sectionDescription')),
        h('p', { style: noteStyle }, browserStatus),
        h(SettingsCard, { view: 'page', form: adapter, t, knowledgeDefault: runtime.knowledgePath ?? '' }));
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'troubleshooting: settings dictionaries');
        fallbackT = ctx.locale.bind(NS);
        if (!ctx.configForms || typeof ctx.slots?.inject !== 'function') return;
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'test-troubleshooting', order: 25,
          label: () => ctx.locale.bind(NS)('sectionLabel'),
          inject: () => ({ t: ctx.locale.bind(NS), configForms: ctx.configForms }),
        }, SettingsSectionPanel)), 'troubleshooting: settings section');
      },
    };
  },
});
