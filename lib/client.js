/** Browser Settings module for the local Antigravity account pool. */

window.__ModuleLoader__.load({
  id: 'dsh-subscription-antigravity',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const CHANNEL = '/subscription-antigravity'
    const NS = 'dsh-subscription-antigravity'
    const LOGIN_POLL_MS = 2000

    const en = {
      nav: 'Antigravity',
      title: 'Antigravity (Google AI subscription)',
      intro: 'Save multiple Google accounts locally, inspect each account quota, and switch without signing in again.',
      accountsTitle: 'Account pool',
      statusLoading: 'Loading Antigravity accounts…',
      statusLoadFailed: 'Failed to load Antigravity accounts.',
      statusConnected: 'Connected',
      statusExpired: 'Refresh required',
      statusDisconnected: 'No saved accounts',
      active: 'Active',
      addAccount: 'Add Google account',
      loginStarting: 'Starting sign-in…',
      loginWaiting: 'Complete Google sign-in in the new browser tab…',
      loginSucceeded: 'Account added.',
      loginFailed: 'Sign-in failed.',
      loginCancelled: 'Sign-in cancelled.',
      loginCancel: 'Cancel sign-in',
      pasteTitle: 'Browser on another machine?',
      pasteIntro: 'Paste the full callback URL (http://localhost:51121/oauth-callback?…) from that browser.',
      pastePlaceholder: 'http://localhost:51121/oauth-callback?state=…&code=…',
      pasteSubmit: 'Complete sign-in',
      pasteInvalid: 'That callback could not be used.',
      switchAccount: 'Use this account',
      switchingAccount: 'Switching…',
      removeAccount: 'Remove',
      removingAccount: 'Removing…',
      removeConfirm: 'Remove {account} from the local Antigravity account pool?',
      accountActionFailed: 'Account action failed.',
      autoFailover: 'Automatically switch on exhausted quota',
      autoFailoverHelp: 'Off by default. Only explicit quota-exhausted 429 responses can trigger a switch; ordinary rate limits and network errors do not.',
      projectLabel: 'Project: {projectId}',
      modelsTitle: 'Models',
      modelsIntro: 'The model picker keeps one Antigravity provider; its new requests use the active account shown above.',
      modelHeader: 'Model',
      inputHeader: 'Input',
      thinkingHeader: 'Thinking levels',
      usageTitle: 'Quota',
      usageRefresh: 'Refresh',
      usageRefreshAll: 'Refresh all quotas',
      usageRefreshing: 'Refreshing…',
      usageUnavailable: 'Quota is temporarily unavailable.',
      usageSummaryUnavailable: 'Aggregate quota is unavailable; runtime-model quota is shown below.',
      usageResetsAt: 'resets {when}',
      usagePerModel: 'Runtime-model details',
      usageKnownModels: '{count} models with known quota',
      usageMinimum: 'Lowest remaining: {percent}%',
      usageError: 'Quota error',
      noQuotaModels: 'No per-model quota was returned.',
    }

    const zh = {
      nav: 'Antigravity',
      title: 'Antigravity（Google AI 订阅）',
      intro: '在本机保存多个 Google 账号，查看每个账号的额度，并且无需重新登录即可切换。',
      accountsTitle: '账号池',
      statusLoading: '正在加载 Antigravity 账号…',
      statusLoadFailed: '加载 Antigravity 账号失败。',
      statusConnected: '已连接',
      statusExpired: '需要刷新授权',
      statusDisconnected: '尚未保存账号',
      active: '当前账号',
      addAccount: '添加 Google 账号',
      loginStarting: '正在启动登录…',
      loginWaiting: '请在新的浏览器标签页中完成 Google 登录…',
      loginSucceeded: '账号已添加。',
      loginFailed: '登录失败。',
      loginCancelled: '登录已取消。',
      loginCancel: '取消登录',
      pasteTitle: '浏览器在另一台机器上？',
      pasteIntro: '把那台浏览器地址栏里的完整回调 URL（http://localhost:51121/oauth-callback?…）粘贴到这里。',
      pastePlaceholder: 'http://localhost:51121/oauth-callback?state=…&code=…',
      pasteSubmit: '完成登录',
      pasteInvalid: '该回调无法使用。',
      switchAccount: '切换到此账号',
      switchingAccount: '正在切换…',
      removeAccount: '移除',
      removingAccount: '正在移除…',
      removeConfirm: '确定从本机 Antigravity 账号池移除 {account}？',
      accountActionFailed: '账号操作失败。',
      autoFailover: '额度耗尽时自动切换账号',
      autoFailoverHelp: '默认关闭。仅明确的额度耗尽 429 会触发切换；普通限流和网络错误不会切换。',
      projectLabel: '项目：{projectId}',
      modelsTitle: '模型',
      modelsIntro: '模型选择器仍只有一个 Antigravity provider；新请求使用上方标记的当前账号。',
      modelHeader: '模型',
      inputHeader: '输入',
      thinkingHeader: '思考级别',
      usageTitle: '额度',
      usageRefresh: '刷新',
      usageRefreshAll: '刷新全部额度',
      usageRefreshing: '正在刷新…',
      usageUnavailable: '额度暂时无法获取。',
      usageSummaryUnavailable: '聚合额度不可用；下面仍显示 runtime model 额度。',
      usageResetsAt: '{when} 重置',
      usagePerModel: 'Runtime model 明细',
      usageKnownModels: '{count} 个模型有额度数据',
      usageMinimum: '最低剩余：{percent}%',
      usageError: '额度错误',
      noQuotaModels: '上游未返回单模型额度。',
    }

    function interpolate(template, params) {
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    function fallbackT(key, params) {
      return interpolate(zh[key] ?? key, params)
    }

    function useT(locale) {
      if (locale !== undefined && typeof locale.subscribe === 'function' && typeof locale.bind === 'function') {
        React.useSyncExternalStore(locale.subscribe, () => locale.getSnapshot().revision, () => locale.getSnapshot().revision)
        return locale.bind(NS)
      }
      return fallbackT
    }

    function createStore() {
      let state = {
        status: 'idle',
        accounts: [],
        activeAccountId: null,
        autoFailover: false,
        models: [],
        usages: {},
        usageStates: {},
        usageAllState: 'idle',
        login: null,
        busy: null,
        error: null,
      }
      const listeners = new Set()
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        update(patch) {
          state = { ...state, ...patch }
          listeners.forEach(listener => listener())
        },
      }
    }

    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    }

    function errorMessage(result, fallback) {
      return result?.error?.message ?? fallback
    }

    async function loadStatus(store, connection) {
      store.update({ status: 'loading' })
      try {
        const [accountsResult, modelsResult] = await Promise.all([
          connection.rpc.call(CHANNEL, 'accounts', {}),
          connection.rpc.call(CHANNEL, 'models', {}),
        ])
        if (!accountsResult.ok) throw new Error(errorMessage(accountsResult))
        const value = accountsResult.value
        const models = modelsResult.ok && Array.isArray(modelsResult.value.models) ? modelsResult.value.models : []
        store.update({
          status: 'ready',
          accounts: Array.isArray(value.accounts) ? value.accounts : [],
          activeAccountId: typeof value.activeAccountId === 'string' ? value.activeAccountId : null,
          autoFailover: value.autoFailover === true,
          models,
          error: null,
        })
      } catch (cause) {
        store.update({ status: 'load-failed', error: cause instanceof Error ? cause.message : undefined })
      }
    }

    async function loadAllUsage(store, connection, { refresh = false } = {}) {
      store.update({ usageAllState: 'loading' })
      try {
        const result = await connection.rpc.call(CHANNEL, 'usage-all', { refresh })
        if (!result.ok) throw new Error(errorMessage(result))
        const usages = {}
        const usageStates = {}
        for (const usage of result.value.usages ?? []) {
          if (typeof usage?.accountId !== 'string') continue
          usages[usage.accountId] = usage
          usageStates[usage.accountId] = 'ready'
        }
        store.update({ usages, usageStates, usageAllState: 'ready' })
      } catch {
        store.update({ usageAllState: 'failed' })
      }
    }

    async function loadUsage(store, connection, accountId, { refresh = false } = {}) {
      const before = store.getSnapshot()
      store.update({ usageStates: { ...before.usageStates, [accountId]: 'loading' } })
      try {
        const result = await connection.rpc.call(CHANNEL, 'usage', { accountId, refresh })
        if (!result.ok) throw new Error(errorMessage(result))
        const current = store.getSnapshot()
        store.update({
          usages: { ...current.usages, [accountId]: result.value.usage },
          usageStates: { ...current.usageStates, [accountId]: 'ready' },
        })
      } catch {
        const current = store.getSnapshot()
        store.update({ usageStates: { ...current.usageStates, [accountId]: 'failed' } })
      }
    }

    async function reloadEverything(store, connection, { refreshUsage = false } = {}) {
      await loadStatus(store, connection)
      if (store.getSnapshot().accounts.length > 0) await loadAllUsage(store, connection, { refresh: refreshUsage })
    }

    function ThinkingLevels({ model }) {
      const levels = Object.entries(model.reasoningEfforts ?? {})
        .filter(([, value]) => typeof value === 'string')
        .map(([level]) => level)
      return h('td', { style: tdStyle }, levels.length === 0 ? '—' : levels.join(' / '))
    }

    function Section(props) {
      const store = props.store
      const state = useStore(store)
      const t = useT(props.locale)

      React.useEffect(() => {
        if (state.status === 'idle') void reloadEverything(store, props.connection)
      }, [state.status, store, props.connection])

      React.useEffect(() => {
        const login = state.login
        if (login === null || login.settled) return undefined
        const timer = setInterval(() => {
          void (async () => {
            const result = await props.connection.rpc.call(CHANNEL, 'login-status', { loginId: login.loginId })
            if (!result.ok) {
              store.update({ login: { ...login, settled: true }, error: errorMessage(result, t('loginFailed')) })
              return
            }
            const status = result.value.status
            if (status.kind === 'pending') return
            if (status.kind === 'succeeded') {
              store.update({ login: null, error: null })
              await reloadEverything(store, props.connection, { refreshUsage: true })
            } else if (status.kind === 'cancelled') {
              store.update({ login: null, error: t('loginCancelled') })
            } else {
              store.update({ login: { ...login, settled: true }, error: status.message ?? t('loginFailed') })
            }
          })()
        }, LOGIN_POLL_MS)
        return () => clearInterval(timer)
      }, [state.login, store, props.connection, t])

      if (state.status === 'idle' || state.status === 'loading') return h('p', null, t('statusLoading'))
      if (state.status === 'load-failed') return h('p', { style: errorStyle }, state.error ?? t('statusLoadFailed'))

      const loginBusy = state.busy === 'login'
      return h('div', { style: sectionStyle },
        h('h2', null, t('title')),
        h('p', { style: secondaryStyle }, t('intro')),
        h('h3', null, t('accountsTitle')),
        h('div', { style: rowStyle },
          state.login === null
            ? h('button', {
                type: 'button',
                disabled: loginBusy,
                onClick: async () => {
                  const win = window.open('', '_blank')
                  store.update({ busy: 'login' })
                  try {
                    const result = await props.connection.rpc.call(CHANNEL, 'start-login', {})
                    if (!result.ok) {
                      win?.close()
                      throw new Error(errorMessage(result, t('loginFailed')))
                    }
                    if (win !== null && !win.closed) win.location.href = result.value.authUrl
                    store.update({ login: { loginId: result.value.loginId, settled: false }, error: null })
                  } catch (cause) {
                    win?.close()
                    store.update({ error: cause instanceof Error ? cause.message : t('loginFailed') })
                  } finally {
                    store.update({ busy: null })
                  }
                },
              }, loginBusy ? t('loginStarting') : t('addAccount'))
            : null,
          state.accounts.length > 0
            ? h('button', {
                type: 'button',
                disabled: state.usageAllState === 'loading',
                onClick: () => void loadAllUsage(store, props.connection, { refresh: true }),
              }, state.usageAllState === 'loading' ? t('usageRefreshing') : t('usageRefreshAll'))
            : null,
        ),
        h('label', { style: rowStyle },
          h('input', {
            type: 'checkbox',
            checked: state.autoFailover,
            disabled: state.busy === 'auto-failover',
            onChange: async event => {
              const enabled = event.target.checked
              store.update({ busy: 'auto-failover' })
              try {
                const result = await props.connection.rpc.call(CHANNEL, 'set-auto-failover', { enabled })
                if (!result.ok) throw new Error(errorMessage(result, t('accountActionFailed')))
                store.update({ autoFailover: enabled, error: null })
              } catch (cause) {
                store.update({ error: cause instanceof Error ? cause.message : t('accountActionFailed') })
              } finally {
                store.update({ busy: null })
              }
            },
          }),
          h('span', null, t('autoFailover')),
        ),
        h('p', { style: secondaryStyle }, t('autoFailoverHelp')),
        state.login === null ? null : h(LoginPanel, { store, connection: props.connection, t, login: state.login }),
        state.accounts.length === 0
          ? h('p', { style: secondaryStyle }, t('statusDisconnected'))
          : h('div', { style: accountGridStyle }, ...state.accounts.map(account => h(AccountCard, {
              key: account.accountId,
              account,
              state,
              store,
              connection: props.connection,
              t,
            }))),
        state.error !== null ? h('p', { style: errorStyle }, state.error) : null,
        h('h3', null, t('modelsTitle')),
        h('p', { style: secondaryStyle }, t('modelsIntro')),
        h('table', { style: tableStyle },
          h('thead', null, h('tr', null,
            h('th', { style: thStyle }, t('modelHeader')),
            h('th', { style: thStyle }, t('inputHeader')),
            h('th', { style: thStyle }, t('thinkingHeader')),
          )),
          h('tbody', null, ...state.models.map(model => h('tr', { key: model.id },
            h('td', { style: tdStyle }, model.name ?? model.id),
            h('td', { style: tdStyle }, Array.isArray(model.input) ? model.input.join(', ') : 'text'),
            h(ThinkingLevels, { model }),
          ))),
        ),
      )
    }

    function LoginPanel({ store, connection, t, login }) {
      return h('div', { style: cardStyle },
        h('p', null, t('loginWaiting')),
        h('button', {
          type: 'button',
          onClick: async () => {
            const result = await connection.rpc.call(CHANNEL, 'cancel-login', { loginId: login.loginId })
            if (!result.ok) store.update({ error: errorMessage(result, t('loginFailed')) })
          },
        }, t('loginCancel')),
        h('h4', null, t('pasteTitle')),
        h('p', { style: secondaryStyle }, t('pasteIntro')),
        h(PasteForm, { store, connection, t, loginId: login.loginId }),
      )
    }

    function PasteForm(props) {
      const [draft, setDraft] = React.useState('')
      const [submitting, setSubmitting] = React.useState(false)
      const [error, setError] = React.useState(null)
      return h('div', { style: rowStyle },
        h('input', {
          type: 'text', autoComplete: 'off', spellCheck: false, value: draft,
          placeholder: props.t('pastePlaceholder'), disabled: submitting, style: inputStyle,
          onChange: event => setDraft(event.target.value),
        }),
        h('button', {
          type: 'button', disabled: submitting || draft.trim().length === 0,
          onClick: async () => {
            setSubmitting(true)
            setError(null)
            try {
              const result = await props.connection.rpc.call(CHANNEL, 'paste-callback', { loginId: props.loginId, url: draft.trim() })
              if (!result.ok) throw new Error(errorMessage(result, props.t('pasteInvalid')))
              props.store.update({ login: null, error: null })
              await reloadEverything(props.store, props.connection, { refreshUsage: true })
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : props.t('pasteInvalid'))
            } finally {
              setSubmitting(false)
            }
          },
        }, submitting ? props.t('loginStarting') : props.t('pasteSubmit')),
        error !== null ? h('p', { style: errorStyle }, `${props.t('pasteInvalid')} ${error}`) : null,
      )
    }

    function AccountCard({ account, state, store, connection, t }) {
      const accountId = account.accountId
      const active = accountId === state.activeAccountId
      const usage = state.usages[accountId]
      const usageState = state.usageStates[accountId] ?? (state.usageAllState === 'loading' ? 'loading' : 'idle')
      const identity = account.email ?? `${accountId.slice(0, 18)}…`
      const busySwitch = state.busy === `switch:${accountId}`
      const busyRemove = state.busy === `remove:${accountId}`
      return h('article', { style: { ...cardStyle, ...(active ? activeCardStyle : {}) } },
        h('div', { style: rowStyle },
          h('strong', { style: identityStyle }, identity),
          active ? h('span', { style: activeBadgeStyle }, t('active')) : null,
          account.expired === true ? h('span', { style: warningBadgeStyle }, t('statusExpired')) : h('span', { style: badgeStyle }, t('statusConnected')),
        ),
        typeof account.projectId === 'string' ? h('p', { style: secondaryStyle }, interpolate(t('projectLabel'), { projectId: account.projectId })) : null,
        h(QuotaView, { usage, usageState, t }),
        h('div', { style: rowStyle },
          active ? null : h('button', {
            type: 'button', disabled: busySwitch || state.busy !== null,
            onClick: async () => {
              store.update({ busy: `switch:${accountId}` })
              try {
                const result = await connection.rpc.call(CHANNEL, 'activate-account', { accountId })
                if (!result.ok) throw new Error(errorMessage(result, t('accountActionFailed')))
                await loadStatus(store, connection)
              } catch (cause) {
                store.update({ error: cause instanceof Error ? cause.message : t('accountActionFailed') })
              } finally {
                store.update({ busy: null })
              }
            },
          }, busySwitch ? t('switchingAccount') : t('switchAccount')),
          h('button', {
            type: 'button', disabled: usageState === 'loading',
            onClick: () => void loadUsage(store, connection, accountId, { refresh: true }),
          }, usageState === 'loading' ? t('usageRefreshing') : t('usageRefresh')),
          h('button', {
            type: 'button', disabled: busyRemove || state.busy !== null,
            onClick: async () => {
              if (!window.confirm(interpolate(t('removeConfirm'), { account: identity }))) return
              store.update({ busy: `remove:${accountId}` })
              try {
                const result = await connection.rpc.call(CHANNEL, 'remove-account', { accountId })
                if (!result.ok) throw new Error(errorMessage(result, t('accountActionFailed')))
                await reloadEverything(store, connection)
              } catch (cause) {
                store.update({ error: cause instanceof Error ? cause.message : t('accountActionFailed') })
              } finally {
                store.update({ busy: null })
              }
            },
          }, busyRemove ? t('removingAccount') : t('removeAccount')),
        ),
      )
    }

    function QuotaView({ usage, usageState, t }) {
      if (usageState === 'loading' || usageState === 'idle') return h('p', { style: secondaryStyle }, t('usageRefreshing'))
      if (usageState === 'failed' || usage === undefined) return h('p', { style: errorStyle }, t('usageUnavailable'))
      const models = Array.isArray(usage.models) ? usage.models : []
      const known = models.filter(model => typeof model.remaining === 'number')
      const minimum = known.length === 0 ? undefined : Math.min(...known.map(model => model.remaining))
      const resets = models.map(model => model.resetsAt).filter(value => typeof value === 'string').sort()
      return h('div', null,
        h('h4', { style: compactHeadingStyle }, t('usageTitle')),
        usage.error !== undefined ? h('p', { style: errorStyle }, `${t('usageError')}: ${usage.error}`) : null,
        known.length > 0 ? h('div', { style: rowStyle },
          h('span', null, interpolate(t('usageMinimum'), { percent: Math.round(minimum * 100) })),
          h('span', { style: secondaryStyle }, interpolate(t('usageKnownModels'), { count: known.length })),
          resets.length > 0 ? h('span', { style: secondaryStyle }, interpolate(t('usageResetsAt'), { when: formatResetTime(resets[0]) })) : null,
        ) : h('p', { style: secondaryStyle }, t('noQuotaModels')),
        models.length > 0 ? h('details', null,
          h('summary', null, t('usagePerModel')),
          h('ul', { style: compactListStyle }, ...models.map(entry => h('li', { key: entry.id },
            `${entry.id}${typeof entry.remaining === 'number' ? ` — ${Math.round(entry.remaining * 100)}%` : ''}`
            + (typeof entry.resetsAt === 'string' ? ` · ${interpolate(t('usageResetsAt'), { when: formatResetTime(entry.resetsAt) })}` : ''),
          ))),
        ) : null,
      )
    }

    function formatResetTime(iso) {
      try {
        const date = new Date(iso)
        if (Number.isNaN(date.getTime())) return iso
        return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      } catch {
        return iso
      }
    }

    const sectionStyle = { display: 'flex', flexDirection: 'column', gap: 10 }
    const secondaryStyle = { opacity: 0.72, margin: 0 }
    const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
    const accountGridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 12 }
    const cardStyle = { border: '1px solid color-mix(in srgb, currentColor 18%, transparent)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }
    const activeCardStyle = { borderColor: '#4f8cff', boxShadow: '0 0 0 1px #4f8cff inset' }
    const badgeStyle = { fontSize: '0.82em', opacity: 0.8 }
    const activeBadgeStyle = { ...badgeStyle, color: '#4f8cff', fontWeight: 600 }
    const warningBadgeStyle = { ...badgeStyle, color: '#c27c0e' }
    const identityStyle = { overflowWrap: 'anywhere', minWidth: 0 }
    const errorStyle = { color: '#c0392b', margin: 0 }
    const tableStyle = { borderCollapse: 'collapse', width: '100%', maxWidth: 720 }
    const thStyle = { textAlign: 'left', borderBottom: '1px solid currentColor', padding: '4px 8px' }
    const tdStyle = { borderBottom: '1px solid color-mix(in srgb, currentColor 15%, transparent)', padding: '4px 8px' }
    const inputStyle = { flex: '1 1 320px', minWidth: 240 }
    const compactHeadingStyle = { margin: '4px 0' }
    const compactListStyle = { margin: '6px 0', paddingLeft: 22 }

    function readLocale(ctx) {
      try { return ctx.locale } catch { return undefined }
    }

    function registerCopy(locale) {
      try {
        return locale.register(NS, { zh, en })
      } catch (error) {
        if (!String(error?.message ?? error).includes('already has locale')) throw error
        return () => {}
      }
    }

    function apply(ctx) {
      const store = createStore()
      const locale = readLocale(ctx)
      if (locale !== undefined && typeof locale.register === 'function') {
        if (typeof ctx.effect === 'function') ctx.effect(() => registerCopy(locale), 'dsh-subscription-antigravity: copy dictionaries')
        else registerCopy(locale)
      }
      const t = locale !== undefined && typeof locale.bind === 'function' ? locale.bind(NS) : fallbackT
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'antigravity', order: 13, label: () => t('nav'),
        inject: () => ({ store, connection: ctx.connection, locale }),
      }, props => h(Section, { ...props, store, connection: ctx.connection, locale })))
    }

    return { apply, inject: ['slots', 'connection'], locales: { en, zh } }
  },
})
