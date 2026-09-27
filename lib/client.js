/**
 * @dsh-external/dsh-browser-use — client half.
 *
 * 手写的 ModuleLoader 包（免构建链）。提供右侧栏 `browser` 标签页：
 *  - 实时投屏（MJPEG）
 *  - **可操作**：鼠标（移动/按下/抬起/滚轮）与键盘直接转发进 Agent 的浏览器，
 *    登录、验证码、人工确认都能自己来
 *  - 地址栏「前往」唤起**用户自己的**桌面浏览器；「让 AI 打开」才驱动 Agent 的浏览器
 *
 * 契约为本部署一方源码实测：
 *  - 标签类型注册：ctx.inject(['sidebarRightTabs'], …) → tabs.register({ id, kind, priority, title })
 *  - 面板主体：ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key }, Component))
 *  - 打开面板：ctx.sidebarRight.openTab(kind, { revealIfOpened: true })
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-browser-use',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const h = React.createElement
    const TAB_ID = '@dsh-external/dsh-browser-use/panel'
    const TAB_KIND = 'browser'
    const BASE = '/browser-panel'

    /** slots 是硬依赖：没有它就没有任何 UI 挂载点。 */
    const inject = ['slots']

    /** 浏览器里没有的「特殊键」才需要真按键；可打印字符走 insertText。 */
    const SPECIAL_KEYS = {
      Enter: 'Enter',
      Backspace: 'Backspace',
      Delete: 'Delete',
      Tab: 'Tab',
      Escape: 'Escape',
      ArrowUp: 'ArrowUp',
      ArrowDown: 'ArrowDown',
      ArrowLeft: 'ArrowLeft',
      ArrowRight: 'ArrowRight',
      Home: 'Home',
      End: 'End',
      PageUp: 'PageUp',
      PageDown: 'PageDown',
    }

    const css = {
      wrap: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        fontSize: '12px',
      },
      bar: { display: 'flex', gap: '6px', alignItems: 'center', padding: '8px', borderBottom: '1px solid var(--dsh-border, rgba(127,127,127,0.25))', flex: '0 0 auto' },
      input: { flex: '1 1 auto', minWidth: 0, padding: '4px 6px', borderRadius: '6px', border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))', background: 'transparent', color: 'inherit', fontSize: '12px' },
      button: { flex: '0 0 auto', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px' },
      stage: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', background: 'var(--dsh-surface-sunken, rgba(127,127,127,0.08))', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', outline: 'none', position: 'relative' },
      img: { display: 'block', width: '100%', height: 'auto', userSelect: 'none', cursor: 'default' },
      badge: { position: 'absolute', top: '6px', right: '6px', padding: '2px 6px', borderRadius: '999px', fontSize: '11px', background: 'rgba(0,0,0,0.55)', color: '#fff', pointerEvents: 'none' },
      meta: { flex: '0 0 auto', padding: '6px 8px', borderTop: '1px solid var(--dsh-border, rgba(127,127,127,0.25))', opacity: 0.75, wordBreak: 'break-all', lineHeight: 1.45 },
      hint: { padding: '24px 16px', opacity: 0.7, textAlign: 'center', lineHeight: 1.6 },
    }

    /** 取按钮的人类可读名，用于错误提示。 */
    const buttonName = (code) => (code === 1 ? 'middle' : code === 2 ? 'right' : 'left')

    function BrowserPane() {
      const [url, setUrl] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [state, setState] = React.useState({ running: false, tabs: [], active: '', url: '', title: '', viewport: null })
      const [nonce, setNonce] = React.useState(0)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [focused, setFocused] = React.useState(false)

      const editing = React.useRef(false)
      const imgRef = React.useRef(null)
      const stageRef = React.useRef(null)
      const lastMove = React.useRef(0)

      // 状态轮询：URL / 标题 / 标签 / 视口尺寸（坐标换算要用）
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const response = await fetch(BASE + '/state', { headers: { accept: 'application/json' } })
            if (response.ok && alive) {
              const next = await response.json()
              setState(next)
              setUrl(next.url || '')
            }
          } catch {
            /* 下一轮再试 */
          }
        }
        void tick()
        const handle = window.setInterval(() => {
          void tick()
        }, 1500)
        return () => {
          alive = false
          window.clearInterval(handle)
        }
      }, [])

      React.useEffect(() => {
        if (!editing.current) setDraft(url)
      }, [url])

      const post = async (path, payload) => {
        const response = await fetch(BASE + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(String(body.error || 'HTTP ' + String(response.status)))
        return body
      }

      /** 显示尺寸 → 页面 CSS 坐标（帧覆盖整个视口，直接按视口比例换算）。 */
      const toPageCoords = (event) => {
        const img = imgRef.current
        if (img === null) return null
        const rect = img.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return null
        const viewport = state.viewport || { width: img.naturalWidth, height: img.naturalHeight }
        if (!viewport || !viewport.width || !viewport.height) return null
        return {
          x: Math.round((event.clientX - rect.left) * (viewport.width / rect.width)),
          y: Math.round((event.clientY - rect.top) * (viewport.height / rect.height)),
        }
      }

      const sendInput = (payload) => {
        void post('/input', payload).catch((cause) => {
          setError(String(cause && cause.message ? cause.message : cause))
        })
      }

      // 滚轮必须用非 passive 监听才能在 React 的合成事件之外拦掉页面自身滚动
      React.useEffect(() => {
        const stage = stageRef.current
        if (stage === null) return undefined
        const onWheel = (event) => {
          const coords = toPageCoords(event)
          if (coords === null) return
          event.preventDefault()
          sendInput({ kind: 'wheel', ...coords, deltaX: event.deltaX, deltaY: event.deltaY })
        }
        stage.addEventListener('wheel', onWheel, { passive: false })
        return () => {
          stage.removeEventListener('wheel', onWheel)
        }
      })

      const onMouseDown = (event) => {
        const coords = toPageCoords(event)
        if (coords === null) return
        event.preventDefault()
        if (stageRef.current !== null) stageRef.current.focus()
        sendInput({ kind: 'down', ...coords, button: buttonName(event.button) })
      }

      const onMouseUp = (event) => {
        const coords = toPageCoords(event)
        if (coords === null) return
        event.preventDefault()
        sendInput({ kind: 'up', ...coords, button: buttonName(event.button) })
      }

      const onMouseMove = (event) => {
        // hover / 拖拽需要 move，但没必要每像素都发
        const now = Date.now()
        if (now - lastMove.current < 60) return
        lastMove.current = now
        const coords = toPageCoords(event)
        if (coords === null) return
        sendInput({ kind: 'move', ...coords })
      }

      const onPaste = (event) => {
        const text = event.clipboardData ? event.clipboardData.getData('text') : ''
        if (text === '') return
        event.preventDefault()
        // 粘贴走 insertText：剪贴板内容是本机用户的，不经过面板字段
        sendInput({ kind: 'text', text })
        setNotice('已粘贴 ' + String(text.length) + ' 字符')
      }

      const onKeyDown = (event) => {
        if (event.ctrlKey || event.metaKey) {
          const letter = event.key.length === 1 ? event.key.toLowerCase() : ''
          if ('acvxz'.includes(letter) && letter !== '') {
            event.preventDefault()
            sendInput({ kind: 'key', key: 'Control+' + letter.toUpperCase() })
            if (letter === 'v') setNotice('Ctrl+V 用右侧「粘贴」更可靠')
          }
          return
        }
        if (event.altKey) return
        if (event.key.length === 1) {
          event.preventDefault()
          sendInput({ kind: 'text', text: event.key })
          return
        }
        const mapped = SPECIAL_KEYS[event.key]
        if (mapped !== undefined) {
          event.preventDefault()
          sendInput({ kind: 'key', key: mapped })
        }
      }

      const goLocal = async () => {
        const target = draft.trim()
        if (target.length === 0) return
        try {
          setError('')
          const body = await post('/open-local', { url: target })
          const app = body.target !== undefined && body.target !== '' ? String(body.target) : String(body.launcher || '')
          setNotice('已交给你的浏览器打开' + (app === '' ? '' : '（' + app + '）'))
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        }
      }

      const goAgent = async () => {
        const target = draft.trim()
        if (target.length === 0) return
        try {
          setError('')
          await post('/navigate', { url: target })
          setNotice('已让 AI 的浏览器前往该地址')
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        }
      }

      const onUrlKeyDown = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void goLocal()
        }
      }

      const tabs = Array.isArray(state.tabs) ? state.tabs : []

      return h('div', { style: css.wrap },
        h('div', { style: css.bar },
          h('input', {
            style: css.input,
            value: draft,
            placeholder: '输入 URL 后回车 → 用你自己的浏览器打开',
            spellCheck: false,
            onFocus: () => {
              editing.current = true
            },
            onBlur: () => {
              editing.current = false
            },
            onChange: (event) => {
              setDraft(event.target.value)
            },
            onKeyDown: onUrlKeyDown,
          }),
          h('button', { style: css.button, type: 'button', title: '在你自己的桌面浏览器里打开', onClick: () => void goLocal() }, '我的浏览器'),
          h('button', { style: css.button, type: 'button', title: '让 AI 的浏览器前往这个地址', onClick: () => void goAgent() }, 'AI 打开'),
          h('button', {
            style: css.button,
            type: 'button',
            title: '重新连接投屏',
            onClick: () => {
              setNonce((value) => value + 1)
            },
          }, '重连'),
        ),
        h('div', {
          ref: stageRef,
          style: { ...css.stage, boxShadow: focused ? 'inset 0 0 0 2px var(--dsh-accent, #4c8dff)' : 'none' },
          tabIndex: 0,
          onMouseDown,
          onMouseUp,
          onMouseMove,
          onKeyDown,
          onPaste,
          onFocus: () => {
            setFocused(true)
          },
          onBlur: () => {
            setFocused(false)
          },
        },
          state.running
            ? h('img', {
                ref: imgRef,
                key: nonce,
                style: css.img,
                alt: '浏览器实时画面（可直接点击操作）',
                draggable: false,
                src: BASE + '/stream?n=' + String(nonce),
              })
            : h('div', { style: css.hint },
                '浏览器尚未启动。',
                h('br'),
                '让 Agent 调用 browser_open，或点「AI 打开」。',
              ),
          state.running
            ? h('div', { style: css.badge }, focused ? '可直接操作' : '点此接管操作')
            : null,
        ),
        h('div', { style: css.meta },
          h('div', null, state.running ? (state.title || '(无标题)') : '未运行', state.persistent === true ? ' · 登录态已持久化' : ''),
          h('div', null, url || ''),
          tabs.length > 0 ? h('div', null, '标签页: ' + tabs.map((tab) => (tab.active ? '*' : '') + tab.id).join(' ')) : null,
          notice !== '' ? h('div', { style: { opacity: 0.9 } }, notice) : null,
          error !== '' ? h('div', { style: { color: 'var(--dsh-danger, #d9534f)' } }, error) : null,
        ),
      )
    }

    /**
     * 打开右侧栏的浏览器面板。
     *
     * `sidebarRight.openTab()` 走 controller.require()，要求右侧栏座位当前已挂载
     * （右栏座位在「主面板不是会话」时整棵不渲染）。座位未挂载时会抛错，
     * 因此先开一次右栏把座位挂上再重试；最终仍失败就把原因显示在按钮上，
     * 不再静默吞掉——静默正是「点了没反应」的成因。
     */
    function OpenButton() {
      const [note, setNote] = React.useState('')

      const attempt = (tries) => {
        const ctx = ctx0
        if (ctx === null) {
          setNote('插件尚未就绪')
          return
        }
        const sidebarRight = ctx.get('sidebarRight')
        if (sidebarRight === undefined) {
          setNote('侧栏控制器不可用')
          return
        }
        try {
          sidebarRight.openTab(TAB_KIND, { revealIfOpened: true })
          setNote('')
          return
        } catch (cause) {
          if (tries > 0) {
            const layout = ctx.get('layout')
            if (layout !== undefined && typeof layout.openRightbar === 'function') {
              try {
                layout.openRightbar(true, false)
              } catch {
                /* 座位挂载后重试即可 */
              }
            }
            window.setTimeout(() => attempt(tries - 1), 120)
            return
          }
          const message = String(cause && cause.message ? cause.message : cause)
          setNote(message)
          console.error('[dsh-browser-use] 打开面板失败:', cause)
        }
      }

      return h('button', {
        style: css.button,
        type: 'button',
        title: note === '' ? '打开浏览器面板（可观看也可自己操作）' : '打开面板失败：' + note,
        onClick: () => attempt(8),
      }, note === '' ? '浏览器' : '浏览器 ⚠')
    }

    /** apply 期间捕获的 ctx，供头部按钮回调使用。 */
    let ctx0 = null

    function apply(ctx) {
      ctx0 = ctx
      const slots = ctx.get('slots')
      if (slots === undefined) return

      // 关键：tab 类型必须等 sidebarRightTabs 服务就绪再注册。
      // 一次性 ctx.get 在本插件早于 ui-sidebar-right 装配时会读到 undefined，
      // 于是 tab 类型永不注册——面板 body 在、按钮在，但点击必抛
      // "no tab type is registered as browser"，再被 catch 吞掉 ⇒ 死按钮。
      ctx.inject(['sidebarRightTabs'], (scope) => {
        scope.effect(() => scope.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title: () => '浏览器',
        }), 'browser-use: sidebar tab type')
      })

      ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
      }, BrowserPane)), 'browser-use: sidebar pane body')

      ctx.effect(() => slots.inject('conversation.session.header.utilities', () => slots.register({
        name: 'conversation.session.header.utilities',
        id: 'dsh-browser-use-open',
        order: 60,
        label: () => '浏览器',
      }, OpenButton)), 'browser-use: header open button')
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
