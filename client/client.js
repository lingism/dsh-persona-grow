/**
 * 人格设置面板（浏览器侧）。
 *
 * 注册进 Settings 的「人格」区：当前灵魂、下拉切换、新建灵魂、配置项、保护性禁用。
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

    /**
     * 自绘下拉：原生 <select> 的弹层由系统绘制，深色主题下必白底，所以自己画。
     * 交互和定位参考 @copylee/dsh-computer-use 的 Select（已验证可用）。
     */

    function Select({ options, value, disabled, label, onChange }) {
      // 全内联样式：不注入 <style>、不依赖 CSS 类（注入 style 标签在这个渲染器里踩过坑）
      const [open, setOpen] = react.useState(false)
      const selected = options.findIndex((option) => option.value === value)
      const trigger = {
        boxSizing: 'border-box',
        width: '100%',
        height: '36px',
        padding: '0 12px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        textAlign: 'left',
        border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35))',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-3, rgba(255,255,255,.04))',
        color: 'inherit',
        font: 'inherit',
        fontSize: '13px',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        minWidth: '180px',
      }
      const menu = {
        position: 'absolute',
        top: '100%',
        left: 0,
        right: 0,
        marginTop: '4px',
        zIndex: 20,
        padding: '4px',
        maxHeight: '260px',
        overflowY: 'auto',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1, #2a2a2e)',
        color: 'var(--dsw-alias-label-primary, #eee)',
        boxShadow: '0 10px 32px rgba(0,0,0,.35), 0 0 0 1px rgba(127,127,127,.25)',
      }
      const optionStyle = (active) => ({
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        minHeight: '32px',
        padding: '6px 8px',
        boxSizing: 'border-box',
        borderRadius: '8px',
        fontSize: '13px',
        cursor: 'pointer',
        background: active ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.18))' : 'transparent',
        color: 'inherit',
      })
      return h('div', { style: { position: 'relative', display: 'inline-block', minWidth: '180px' } },
        h('button', {
          type: 'button',
          disabled,
          'aria-label': label,
          style: trigger,
          onClick: () => setOpen(!open),
        },
        h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, options[selected]?.label || ''),
        h('span', { style: { fontSize: '10px', opacity: 0.7 } }, open ? '▲' : '▼')),
        open ? h('div', { style: menu },
          options.map((option, i) => h('div', {
            key: option.value,
            style: optionStyle(i === selected),
            onClick: () => { onChange(option.value); setOpen(false) },
          }, option.label))) : null)
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
        gap: '10px',
      },
      cardTitle: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      badge: {
        fontSize: '13px',
        fontWeight: 600,
        padding: '2px 10px',
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
      select: {
        font: 'inherit',
        fontSize: '13px',
        padding: '3px 8px',
        borderRadius: '6px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-l1)',
        color: 'var(--dsw-alias-label-primary)',
        minWidth: '180px',
        // 原生下拉（option 弹层）是系统绘制的，inline 背景色会被忽略；
        // color-scheme 才会让浏览器把下拉列表也按深色渲染
        colorScheme: 'dark',
      },
      fieldLabel: { fontSize: '13px', minWidth: '120px', color: 'var(--dsw-alias-label-secondary)' },
      input: {
        font: 'inherit',
        fontSize: '13px',
        width: '110px',
        padding: '3px 8px',
        borderRadius: '6px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-l1)',
        color: 'var(--dsw-alias-label-primary)',
      },
      fieldHint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: '18px' },
    }

    /** 每一项配置：说明就是给人看的用途解释。 */
    const CONFIG_FIELDS = [
      { key: 'maxChars', label: '注入预算', unit: '字符', hint: '每轮把人格与经历拼进提示词的字数上限。调大能记住更多，但每轮多花 token；信息超了会优先从弱条目开始砍。' },
      { key: 'careEveryDays', label: '整理提醒', unit: '天', hint: '隔多少天在对话里挂一行提醒你整理人格。到了天数我提醒，真正动手的还是你。' },
      { key: 'recentExperiences', label: '最近经历条数', unit: '条', hint: '每轮注入最近几条经历的标题（正文不注入，靠 persona_recall 按关键词翻）。' },
      { key: 'decayDays', label: '衰减天数', unit: '天/级', hint: '一条条目多少天没被再次印证就降一级强度；被印证会回升。降到底就被归档。' },
      { key: 'minStrength', label: '最低强度', unit: '1-5', hint: '强度低于这个值的条目不注入。1 表示全都注入，5 表示只留最硬的。' },
      { key: 'userLabel', label: '称呼', unit: '文字', hint: '注入文案里怎么称呼你。默认「用户」，你可以改成习惯的叫法。' },
    ]

    function PersonaSection() {
      const h = react.createElement
      const [state, setState] = react.useState(null)
      const [config, setConfig] = react.useState(null)
      const [draft, setDraft] = react.useState({})
      const [newName, setNewName] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')
      const [note, setNote] = react.useState('')

      const load = react.useCallback(() => {
        Promise.all([
          fetch(api('/persona-grow/state')).then((res) => res.json()),
          fetch(api('/persona-grow/config')).then((res) => res.json()),
        ])
          .then(([s, c]) => {
            if (s.error) throw new Error(s.error)
            if (c.error) throw new Error(c.error)
            setState(s)
            setConfig(c)
            setError('')
          })
          .catch((err) => setError(String(err && err.message ? err.message : err)))
      }, [])

      react.useEffect(() => { load() }, [load])

      const post = (path, body, successNote) => {
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
            setNote(successNote || '完成')
            load()
          })
          .catch((err) => setError(String(err && err.message ? err.message : err)))
          .finally(() => setBusy(false))
      }

      const switchTo = (name) => {
        if (!name || (state && name === state.current)) return
        post('/persona-grow/switch', { name }, `已切到「${name}」`)
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
      const options = [{ value: state.current, label: `${state.name}（当前）` }]
        .concat(others.map((item) => ({ value: item.name, label: `${item.name}（${item.entries} 条）` })))

      const configField = (field) => {
        const current = config && config[field.key] !== undefined ? String(config[field.key]) : ''
        const value = draft[field.key] !== undefined ? draft[field.key] : current
        return h('div', { key: field.key, style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('div', { style: S.row },
            h('span', { style: S.fieldLabel }, field.label),
            h('input', {
              style: S.input,
              value,
              onChange: (event) => setDraft({ ...draft, [field.key]: event.target.value }),
            }),
            h('span', { style: S.muted }, field.unit),
            h('button', {
              type: 'button',
              style: S.btn,
              disabled: busy,
              onClick: () => post('/persona-grow/config', { key: field.key, value }, `已保存 ${field.label}`),
            }, '保存'),
          ),
          h('div', { style: S.fieldHint }, field.hint),
        )
      }

      return h('div', { style: S.root },
        h('h2', { style: S.h2 }, '人格'),
        h('p', { style: S.intro }, '同一时刻只有一份灵魂被服务；切换就是两份灵魂的目录对调，下一条消息起生效。'),
        error ? h('div', { style: S.error }, error) : null,
        note ? h('div', { style: S.note }, note) : null,

        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '当前灵魂'),
          h('div', { style: S.row },
            h('span', { style: S.badge }, state.name || state.current),
            h('span', { style: S.muted }, `人格 ${state.personaCount ?? state.currentEntries} · 技能 ${state.skillCount ?? 0}`),
            state.disabled ? h('span', { style: S.warn }, '已禁用（档案为空）') : null,
          ),
          h('div', { style: S.muted }, state.dir || ''),
        ),

        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '灵魂切换'),
          h('div', { style: S.row },
            // 自绘下拉（见 Select 组件）：原生 select 的下拉弹层系统绘制、深色主题下必白底
            h(Select, {
              options,
              value: state.current,
              disabled: busy || state.disabled,
              label: '切换灵魂',
              onChange: (name) => switchTo(name),
            }),
            h('span', { style: S.muted }, others.length === 0 ? '还没有其他灵魂' : `共 ${others.length + 1} 份灵魂`),
          ),
          h('div', { style: S.row },
            h('input', {
              style: S.input,
              placeholder: '新灵魂的名字',
              value: newName,
              onChange: (event) => setNewName(event.target.value),
            }),
            h('button', {
              type: 'button',
              style: S.btn,
              disabled: busy || state.disabled || newName.trim() === '',
              onClick: () => {
                post('/persona-grow/create', { name: newName.trim() }, `已新建灵魂「${newName.trim()}」`)
                setNewName('')
              },
            }, '新建灵魂'),
          ),
          h('div', { style: S.muted }, '新建的灵魂只有名字、没有形象和性格——其余设定在对话里慢慢长出来。'),
        ),

        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '配置'),
          h('p', { style: S.intro }, '改完点保存：写进 profile 的 patch 并立即生效，不用手动改 yaml。'),
          CONFIG_FIELDS.map(configField),
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
                onClick: () => post('/persona-grow/enable', {}, '已还原'),
              }, '还原灵魂'),
              h('span', { style: S.muted }, state.disabledFromExists ? '备份在位' : '备份可能已丢失'),
            )
            : h('div', { style: S.row },
              h('button', {
                type: 'button',
                style: S.btnDanger,
                disabled: busy,
                onClick: () => {
                  if (!window.confirm('确定要禁用灵魂吗？会先备份并校验，然后清空当前档案。')) return
                  post('/persona-grow/disable', {}, '已禁用')
                },
              }, '禁用灵魂'),
            ),
        ),
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
