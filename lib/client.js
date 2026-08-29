/**
 * Browser half of dsh-subscription-antigravity: a Settings section with the
 * Google sign-in card (browser PKCE via the host's loopback callback, plus a
 * paste-the-URL fallback for remote browsers), account status, the model
 * catalog, and best-effort quota usage. Talks to the Host through the
 * loopback-only /subscription-antigravity channel. Structure mirrors
 * dsh-subscription-search/lib/client.js.
 */

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
      intro: 'Use your Google AI Pro / Ultra subscription through Antigravity. Sign-in happens in your browser; credentials stay on this computer.',
      statusTitle: 'Account',
      statusLoading: 'Loading Antigravity status…',
      statusLoadFailed: 'Failed to load Antigravity status.',
      statusConnected: 'Connected',
      statusExpired: 'Signed in (token expired — it will refresh on the next request)',
      statusDisconnected: 'Not connected',
      login: 'Sign in with Google',
      loginStarting: 'Starting sign-in…',
      loginWaiting: 'Complete the Google sign-in in the new browser tab…',
      loginSucceeded: 'Antigravity connected.',
      loginFailed: 'Sign-in failed.',
      loginCancelled: 'Sign-in cancelled.',
      loginCancel: 'Cancel sign-in',
      pasteTitle: 'Browser on another machine?',
      pasteIntro: 'After signing in, paste the full callback URL (http://localhost:51121/oauth-callback?…) from that browser.',
      pastePlaceholder: 'http://localhost:51121/oauth-callback?state=…&code=…',
      pasteSubmit: 'Complete sign-in',
      pasteInvalid: 'That callback could not be used.',
      logout: 'Disconnect',
      logoutFailed: 'Disconnect failed.',
      modelsTitle: 'Models',
      modelsIntro: 'These models appear in the DSH model picker once you are signed in. Quota is shared across your Google AI plan.',
      modelHeader: 'Model',
      inputHeader: 'Input',
      thinkingHeader: 'Thinking levels',
      usageTitle: 'Usage',
      usageRefresh: 'Refresh usage',
      usageRefreshing: 'Refreshing…',
      usageUnavailable: 'Usage is temporarily unavailable.',
      usageSummaryUnavailable: 'Aggregate quota needs a paid Google AI plan; per-model usage may still be shown.',
      usagePerModel: 'Per-model remaining quota',
      usageError: 'Usage error',
      connectedAs: 'Signed in as {email}',
      projectLabel: 'Project: {projectId}',
    }

    const zh = {
      nav: 'Antigravity',
      title: 'Antigravity（Google AI 订阅）',
      intro: '通过 Antigravity 使用你的 Google AI Pro / Ultra 订阅。登录在浏览器中完成；凭据只保存在这台电脑上。',
      statusTitle: '账号',
      statusLoading: '正在加载 Antigravity 状态…',
      statusLoadFailed: '加载 Antigravity 状态失败。',
      statusConnected: '已连接',
      statusExpired: '已登录（令牌已过期——将在下次请求时自动刷新）',
      statusDisconnected: '未连接',
      login: '使用 Google 登录',
      loginStarting: '正在启动登录…',
      loginWaiting: '请在新的浏览器标签页中完成 Google 登录…',
      loginSucceeded: 'Antigravity 已连接。',
      loginFailed: '登录失败。',
      loginCancelled: '登录已取消。',
      loginCancel: '取消登录',
      pasteTitle: '浏览器在另一台机器上？',
      pasteIntro: '登录后，把那台浏览器地址栏里的完整回调 URL（http://localhost:51121/oauth-callback?…）粘贴到这里。',
      pastePlaceholder: 'http://localhost:51121/oauth-callback?state=…&code=…',
      pasteSubmit: '完成登录',
      pasteInvalid: '该回调无法使用。',
      logout: '断开连接',
      logoutFailed: '断开连接失败。',
      modelsTitle: '模型',
      modelsIntro: '登录后这些模型会出现在 DSH 模型选择器中。配额在你的 Google AI 套餐内共享。',
      modelHeader: '模型',
      inputHeader: '输入',
      thinkingHeader: '思考级别',
      usageTitle: '用量',
      usageRefresh: '刷新用量',
      usageRefreshing: '正在刷新…',
      usageUnavailable: '用量暂时无法获取。',
      usageSummaryUnavailable: '聚合配额需要付费 Google AI 套餐；仍可能显示单模型用量。',
      usagePerModel: '单模型剩余配额',
      usageError: '用量错误',
      connectedAs: '登录账号：{email}',
      projectLabel: '项目：{projectId}',
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
        account: null,
        models: [],
        usage: null,
        usageState: 'idle',
        login: null,
        busy: false,
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
        const [providersResult, modelsResult] = await Promise.all([
          connection.rpc.call(CHANNEL, 'providers', {}),
          connection.rpc.call(CHANNEL, 'models', {}),
        ])
        if (!providersResult.ok) throw new Error(errorMessage(providersResult))
        const account = Array.isArray(providersResult.value.providers)
          ? providersResult.value.providers.find(entry => entry?.provider === 'antigravity')
          : undefined
        const models = modelsResult.ok && Array.isArray(modelsResult.value.models) ? modelsResult.value.models : []
        store.update({ status: 'ready', account: account ?? { provider: 'antigravity', configured: false }, models, error: null })
      } catch (cause) {
        store.update({ status: 'load-failed', error: cause instanceof Error ? cause.message : undefined })
      }
    }

    async function loadUsage(store, connection, { refresh = false } = {}) {
      store.update({ usageState: 'loading' })
      try {
        const result = await connection.rpc.call(CHANNEL, 'usage', { refresh })
        if (!result.ok) throw new Error(errorMessage(result))
        store.update({ usage: result.value.usage, usageState: 'ready' })
      } catch {
        store.update({ usageState: 'failed' })
      }
    }

    function ThinkingLevels({ model, t }) {
      const efforts = model.reasoningEfforts ?? {}
      const levels = Object.entries(efforts)
        .filter(([, value]) => typeof value === 'string')
        .map(([level]) => level)
      if (levels.length === 0) return h('td', { style: tdStyle }, '—')
      return h('td', { style: tdStyle }, levels.join(' / '))
    }

    function Section(props) {
      const store = props.store
      const state = useStore(store)
      const t = useT(props.locale)

      React.useEffect(() => {
        if (state.status === 'idle') void loadStatus(store, props.connection)
        if (state.status === 'ready' && state.usageState === 'idle' && state.account?.configured === true) {
          void loadUsage(store, props.connection)
        }
      }, [state.status, state.account, state.usageState, store, props.connection])

      // Poll the pending login until it settles.
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
              await loadStatus(store, props.connection)
            } else if (status.kind === 'cancelled') {
              store.update({ login: null, error: t('loginCancelled') })
            } else {
              store.update({ login: { ...login, settled: true }, error: status.message ?? t('loginFailed') })
            }
          })()
        }, LOGIN_POLL_MS)
        return () => clearInterval(timer)
      }, [state.login, store, props.connection, t])

      if (state.status === 'idle' || state.status === 'loading') {
        return h('p', null, t('statusLoading'))
      }
      if (state.status === 'load-failed') {
        return h('p', { style: errorStyle }, state.error ?? t('statusLoadFailed'))
      }

      const configured = state.account?.configured === true
      return h('div', { style: sectionStyle },
        h('h2', null, t('title')),
        h('p', { style: secondaryStyle }, t('intro')),

        h('h3', null, t('statusTitle')),
        h('div', { style: rowStyle },
          h('span', null, configured
            ? (typeof state.account.email === 'string' ? interpolate(t('connectedAs'), { email: state.account.email }) : t('statusConnected'))
            : t('statusDisconnected')),
          h('span', { style: badgeStyle }, configured ? (state.account.expired === true ? t('statusExpired') : t('statusConnected')) : t('statusDisconnected')),
        ),
        configured && typeof state.account.projectId === 'string'
          ? h('p', { style: secondaryStyle }, interpolate(t('projectLabel'), { projectId: state.account.projectId }))
          : null,
        configured
          ? h('div', { style: rowStyle },
              h('button', {
                type: 'button',
                disabled: state.busy,
                onClick: async () => {
                  store.update({ busy: true })
                  try {
                    const result = await props.connection.rpc.call(CHANNEL, 'logout', {})
                    if (!result.ok) throw new Error(errorMessage(result, t('logoutFailed')))
                    store.update({ usage: null, usageState: 'idle', error: null })
                    await loadStatus(store, props.connection)
                  } catch (cause) {
                    store.update({ error: cause instanceof Error ? cause.message : t('logoutFailed') })
                  } finally {
                    store.update({ busy: false })
                  }
                },
              }, t('logout')),
            )
          : null,

        state.login === null
          ? h('div', { style: rowStyle },
              h('button', {
                type: 'button',
                disabled: state.busy,
                onClick: async () => {
                  // Open the tab synchronously so the browser does not treat the
                  // post-RPC window.open as a blocked popup.
                  const win = window.open('', '_blank')
                  store.update({ busy: true })
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
                    store.update({ busy: false })
                  }
                },
              }, state.busy ? t('loginStarting') : t('login')),
            )
          : h('div', null,
              h('p', null, t('loginWaiting')),
              h('button', {
                type: 'button',
                onClick: async () => {
                  const result = await props.connection.rpc.call(CHANNEL, 'cancel-login', { loginId: state.login.loginId })
                  if (!result.ok) store.update({ error: errorMessage(result, t('loginFailed')) })
                },
              }, t('loginCancel')),
              h('h4', null, t('pasteTitle')),
              h('p', { style: secondaryStyle }, t('pasteIntro')),
              h(PasteForm, { store, connection: props.connection, t, loginId: state.login.loginId }),
            ),

        state.error !== null ? h('p', { style: errorStyle }, state.error) : null,

        h('h3', null, t('modelsTitle')),
        h('p', { style: secondaryStyle }, t('modelsIntro')),
        h('table', { style: tableStyle },
          h('thead', null, h('tr', null,
            h('th', { style: thStyle }, t('modelHeader')),
            h('th', { style: thStyle }, t('inputHeader')),
            h('th', { style: thStyle }, t('thinkingHeader')),
          )),
          h('tbody', null,
            ...state.models.map(model => h('tr', { key: model.id },
              h('td', { style: tdStyle }, model.name ?? model.id),
              h('td', { style: tdStyle }, Array.isArray(model.input) ? model.input.join(', ') : 'text'),
              h(ThinkingLevels, { model, t }),
            )),
          ),
        ),

        configured ? h(UsageArea, { store, state, connection: props.connection, t }) : null,
      )
    }

    function PasteForm(props) {
      const [draft, setDraft] = React.useState('')
      const [submitting, setSubmitting] = React.useState(false)
      const [error, setError] = React.useState(null)
      return h('div', null,
        h('input', {
          type: 'text',
          autoComplete: 'off',
          spellCheck: false,
          value: draft,
          placeholder: props.t('pastePlaceholder'),
          disabled: submitting,
          style: inputStyle,
          onChange: event => setDraft(event.target.value),
        }),
        h('button', {
          type: 'button',
          disabled: submitting || draft.trim().length === 0,
          onClick: async () => {
            setSubmitting(true)
            setError(null)
            try {
              const result = await props.connection.rpc.call(CHANNEL, 'paste-callback', { loginId: props.loginId, url: draft.trim() })
              if (!result.ok) throw new Error(errorMessage(result, props.t('pasteInvalid')))
              props.store.update({ login: null, error: null })
              await loadStatus(props.store, props.connection)
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

    function UsageArea(props) {
      const { store, state, connection, t } = props
      const usage = state.usage
      return h('div', null,
        h('h3', null, t('usageTitle')),
        h('div', { style: rowStyle },
          h('button', {
            type: 'button',
            disabled: state.usageState === 'loading',
            onClick: () => void loadUsage(store, connection, { refresh: true }),
          }, state.usageState === 'loading' ? t('usageRefreshing') : t('usageRefresh')),
        ),
        state.usageState === 'failed'
          ? h('p', { style: errorStyle }, t('usageUnavailable'))
          : usage === null
            ? h('p', { style: secondaryStyle }, t('statusLoading'))
            : h('div', null,
                usage.error !== undefined ? h('p', { style: errorStyle }, `${t('usageError')}: ${usage.error}`) : null,
                usage.summary === undefined && usage.summaryUnavailable !== undefined
                  ? h('p', { style: secondaryStyle }, t('usageSummaryUnavailable'))
                  : null,
                Array.isArray(usage.models) && usage.models.length > 0
                  ? h('div', null,
                      h('h4', null, t('usagePerModel')),
                      h('ul', null,
                        ...usage.models.map(entry => h('li', { key: entry.id },
                          `${entry.id}${typeof entry.remaining === 'number' ? ` — ${Math.round(entry.remaining * 100)}%` : ''}`,
                        )),
                      ),
                    )
                  : null,
              ),
      )
    }

    const sectionStyle = { display: 'flex', flexDirection: 'column', gap: 8 }
    const secondaryStyle = { opacity: 0.75, margin: 0 }
    const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
    const badgeStyle = { fontSize: '0.85em', opacity: 0.85 }
    const errorStyle = { color: '#c0392b', margin: 0 }
    const tableStyle = { borderCollapse: 'collapse', width: '100%', maxWidth: 640 }
    const thStyle = { textAlign: 'left', borderBottom: '1px solid currentColor', padding: '4px 8px' }
    const tdStyle = { borderBottom: '1px solid color-mix(in srgb, currentColor 15%, transparent)', padding: '4px 8px' }
    const inputStyle = { flex: '1 1 320px', minWidth: 240 }

    function readLocale(ctx) {
      try {
        return ctx.locale
      } catch {
        return undefined
      }
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
        name: 'settings.section',
        id: 'antigravity',
        order: 13,
        label: () => t('nav'),
        inject: () => ({ store, connection: ctx.connection, locale }),
      }, props => h(Section, { ...props, store, connection: ctx.connection, locale })))
    }

    // `locales` is a test seam: the parity test reads it to keep the zh/en
    // dictionaries in lockstep. The module loader ignores extra keys.
    return { apply, inject: ['slots', 'connection'], locales: { en, zh } }
  },
})
