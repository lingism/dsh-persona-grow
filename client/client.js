/**
 * 人格设置面板（浏览器侧）。
 *
 * 注册进 Settings 的「人格」区：列出当前档案、同族其他档案、禁用/还原按钮。
 * 数据走 host 注册的 /persona-grow/* HTTP API。
 */
window.__ModuleLoader__.load({
  id: 'dsh-persona-grow',
  factory: (require) => {
    const react = require('react')

    /** 把插件路由解析成同源路径（Electron 的 file:// 与 Web 的 http:// 都适用）。 */
    function api(path) {
      const relative = String(path).replace(/^\/+/, '')
      if (typeof document === 'undefined') return `/${relative}`
      return new URL(relative, document.baseURI).pathname
    }

    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '760px' },
      h2: { margin: '0', fontSize: '18px', fontWeight: 600 },
      intro: { margin: '0', fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' },
      card: {
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: '10px',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      },
      cardTitle: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      badge: {
        fontSize: '13px',
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-state-business-primary)',
        color: '#fff',
      },
      muted: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      warn: { fontSize: '12px', color: 'var(--dsw-alias-state-warning-primary)' },
      body: { fontSize: '13px', lineHeight: '20px' },
      btn: {
        font: 'inherit',
        fontSize: '13px',
        cursor: 'pointer',
        borderRadius: '8px',
        padding: '4px 12px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-l1)',
        color: 'var(--dsw-alias-label-primary)',
      },
      btnPrimary: {
        font: 'inherit',
        fontSize: '13px',
        cursor: 'pointer',
        borderRadius: '8px',
        padding: '4px 12px',
        border: '0',
        background: 'var(--dsw-alias-state-business-primary)',
        color: '#fff',
      },
      btnDanger: {
        font: 'inherit',
        fontSize: '13px',
        cursor: 'pointer',
        borderRadius: '8px',
        padding: '4px 12px',
        border: '0.5px solid var(--dsw-alias-state-error-primary)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
      },
      error: {
        fontSize: '13px',
        padding: '8px 10px',
        borderRadius: '8px',
        background: 'var(--dsw-alias-state-error-secondary)',
        color: 'var(--dsw-alias-state-error-primary)',
      },
      note: {
        fontSize: '13px',
        padding: '8px 10px',
        borderRadius: '8px',
        background: 'var(--dsw-alias-state-success-secondary)',
      },
    }

    function PersonaSection() {
      const h = react.createElement
      const [state, setState] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')
      const [note, setNote] = react.useState('')

      const load = react.useCallback(() => {
        fetch(api('/persona-grow/state'))
          .then((res) => res.json())
          .then((data) => {
            if (data.error) throw new Error(data.error)
            setState(data)
            setError('')
          })
          .catch((err) => setError(String(err && err.message ? err.message : err)))
      }, [])

      react.useEffect(() => { load() }, [load])

      const post = (path, body) => {
        setBusy(true)
        setError('')
        setNote('')
        fetch(api(path), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
          .then((res) => res.json())
          .then((data) => {
            if (data.error) throw new Error(data.error)
            setNote('完成')
            load()
          })
          .catch((err) => setError(String(err && err.message ? err.message : err)))
          .finally(() => setBusy(false))
      }

      if (state === null && error !== '') {
        return h('div', { style: S.root },
          h('h2', { style: S.h2 }, '人格'),
          h('div', { style: S.error }, error),
          h('button', { type: 'button', style: S.btn, onClick: load }, '重试'),
        )
      }
      if (state === null) {
        return h('div', { style: S.root }, h('h2', { style: S.h2 }, '人格'), h('p', { style: S.intro }, '加载中…'))
      }

      const others = Array.isArray(state.others) ? state.others : []
      return h('div', { style: S.root },
        h('h2', { style: S.h2 }, '人格'),
        h('p', { style: S.intro }, '同时只服务一个档案：切换就是两个目录对调，下一条消息起注入的就是她。'),
        error ? h('div', { style: S.error }, error) : null,
        note ? h('div', { style: S.note }, note) : null,
        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '当前档案'),
          h('div', { style: S.row },
            h('span', { style: S.badge }, state.current),
            h('span', { style: S.muted }, `${state.currentEntries} 条`),
            state.disabled ? h('span', { style: S.warn }, '已禁用（档案为空）') : null,
          ),
          h('div', { style: S.muted }, state.dir || ''),
        ),
        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, `其他档案（${others.length}）`),
          others.length === 0
            ? h('div', { style: S.muted }, '还没有同族档案。让我在对话里用 persona_profile 建一个。')
            : others.map((item) => h('div', { key: item.name, style: S.row },
              h('span', { style: S.body }, item.name),
              h('span', { style: S.muted }, `${item.entries} 条`),
              h('button', {
                type: 'button',
                style: S.btnPrimary,
                disabled: busy || state.disabled,
                onClick: () => post('/persona-grow/switch', { name: item.name }),
              }, '切换'),
            )),
        ),
        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '保护性禁用'),
          h('div', { style: S.body },
            state.disabled
              ? '当前已禁用：档案是空的，插件不注入也不写入。'
              : '先整份备份并校验，再清空档案；禁用期间双闸门保证没有东西偷偷写进来。'),
          state.disabled
            ? h('div', { style: S.row },
              h('button', {
                type: 'button',
                style: S.btnPrimary,
                disabled: busy,
                onClick: () => post('/persona-grow/enable'),
              }, '还原人格'),
              h('span', { style: S.muted }, state.disabledFromExists ? '备份在位' : '备份可能已丢失'),
            )
            : h('div', { style: S.row },
              h('button', {
                type: 'button',
                style: S.btnDanger,
                disabled: busy,
                onClick: () => {
                  if (!window.confirm('确定要禁用人格吗？会先备份并校验，然后清空当前档案。')) return
                  post('/persona-grow/disable')
                },
              }, '禁用人格'),
            ),
        ),
        h('div', { style: S.muted }, '配置项（maxChars / careEveryDays 等）仍走插件配置面板。'),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'persona-grow',
        order: 16,
        label: () => '人格',
      }, PersonaSection))
    }

    const module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = ['slots']
    return module.exports
  },
})
