/**
 * `dsh-solpi-observation-pack` 浏览器半边。
 *
 * 作为包的 `./client` 产物发布：DSH 客户端模块系统把它当普通脚本加载
 * （`window.__ModuleLoader__.load({ id, factory })`），再把这个插件挂进浏览器
 * 的 Cordis 树。
 *
 * 它只贡献一个界面——**设置页左侧导航里的独立菜单**（槽 `settings.section`）。
 * 本仓库约定：插件的配置一律只放这一处，不用「插件 → 插件配置」里的卡片
 * （`settings.plugin.item`）——Host 半边已经用 `settings.configure({ auto: false })`
 * 关掉了平台自动生成的那张表单，同一组旋钮只剩左侧菜单一个入口。
 *
 * 读写的是**本插件自己 profile entry 的配置**：Host 侧 `Config` 里标了 `.volatile()`
 * 的字段，浏览器侧由 `configForms` 服务按 entry id 给出同一份共享表单
 * （`ctx.configForms.get(entryId)`），写盘经 profile 的 Cordis patch 落回该 entry。
 *
 * 刻意写成无打包器的普通 CJS：只用浏览器已经提供的 `react` 和 Cordis 服务，
 * 因此不需要 `external` 列表。文案固定中文。
 */

;(function () {
  const PACKAGE = 'dsh-solpi-observation-pack'
  // 本插件在 profile 里的 entry id：既是 `ctx.configForms.get(entryId)` 的 key，
  // 也是 host 侧 `SETTINGS_NS` 与 `settings.section` 槽的 id。
  const NAMESPACE = 'solpi-observation-pack'

  /**
   * 卡片里的字段表：`key` 必须与 host 侧 `Config` 的 volatile 字段一一对应。
   * 说明文字与 host schema 的 description 保持一致，便于对照。
   */
  const FIELDS = [
    {
      key: 'enabled',
      kind: 'boolean',
      label: '启用插件',
      hint: '总开关。关闭后不再打包任何工具结果，已经落地的替换保持原样。',
    },
    {
      key: 'dryRun',
      kind: 'boolean',
      label: '影子模式（只统计，不替换）',
      hint: '只估算「如果打包能省多少 token」，不真的改动上下文、不写归档。用于 A/B 对照和安全评估。',
    },
    {
      key: 'thresholdBytes',
      kind: 'number',
      label: '触发阈值（字节）',
      hint: '工具结果的 UTF-8 字节数超过它才参与打包。默认 10240（10 KiB），与上游 SoL-Pi 一致。',
    },
    {
      key: 'fullSends',
      kind: 'number',
      label: '完整发送次数',
      hint: '前 N 次模型请求照发全文，第 N+1 次起替换为 handle。默认 2，与上游一致；调大更保守。',
    },
    {
      key: 'excerptBytes',
      kind: 'number',
      label: '摘录预算（字节）',
      hint: 'handle 中头、尾各保留一半，且只取完整行、不切开任何一行。默认 1024。',
    },
    {
      key: 'skipTools',
      kind: 'list',
      label: '跳过工具',
      hint: '这些工具的结果永不打包。多个工具名用逗号分隔，例如 read, web_fetch。',
    },
    {
      key: 'emitShadowPrice',
      kind: 'boolean',
      label: '写入影子定价事件',
      hint: '在会话日志里为每个被替换的节点记一条带 token 估价的 compaction/prune 事件，便于事后统计收益。',
    },
  ]

  /** 该字段是否是「已由用户覆盖」。 */
  function isOverridden(user, key) {
    return user !== null && typeof user === 'object' && Object.hasOwn(user, key)
  }

  /** 把已保存的值渲染成控件可编辑的草稿。 */
  function toDraft(field, value) {
    if (field.kind === 'list') return Array.isArray(value) ? value.join(', ') : ''
    if (field.kind === 'boolean') return value === true
    return value === undefined || value === null ? '' : String(value)
  }

  /** 草稿是否非法。 */
  function isInvalid(field, draft) {
    if (field.kind === 'number') {
      if (draft === '') return true
      const n = Number(draft)
      if (!Number.isInteger(n)) return true
      return field.key === 'fullSends' ? n < 1 : n < 0
    }
    return false
  }

  /** 把草稿收敛成写回本插件 entry 配置的 JSON 值。 */
  function toValue(field, draft) {
    if (field.kind === 'list') {
      return draft
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    }
    if (field.kind === 'boolean') return draft === true
    return Number(draft)
  }

  function createCard(React, form) {
    const h = React.createElement

    const S = {
      card: { border: '1px solid var(--dsh-border, #d0d5dd)', borderRadius: 10, padding: '16px 18px', margin: '0 0 14px' },
      title: { margin: '0 0 6px', fontSize: 15, fontWeight: 600 },
      intro: { margin: '0 0 14px', fontSize: 12.5, lineHeight: 1.6, opacity: 0.75 },
      row: { padding: '10px 0', borderTop: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.22))' },
      rowHead: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' },
      label: { fontSize: 13, fontWeight: 500 },
      badge: { fontSize: 11, padding: '1px 6px', borderRadius: 999, border: '1px solid var(--dsh-border, #d0d5dd)', opacity: 0.7 },
      hint: { margin: '4px 0 0', fontSize: 12, lineHeight: 1.6, opacity: 0.66 },
      control: { marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 },
      input: { padding: '5px 8px', fontSize: 13, borderRadius: 6, border: '1px solid var(--dsh-border, #d0d5dd)', background: 'transparent', color: 'inherit', minWidth: 140 },
      actions: { marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' },
      button: { padding: '6px 14px', fontSize: 13, borderRadius: 6, border: '1px solid var(--dsh-border, #d0d5dd)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      buttonPrimary: { padding: '6px 14px', fontSize: 13, borderRadius: 6, border: '1px solid transparent', background: 'var(--dsh-accent, #4d6bfe)', color: '#fff', cursor: 'pointer' },
      error: { fontSize: 12.5, color: 'var(--dsh-danger, #d92d20)' },
      muted: { fontSize: 12, opacity: 0.6 },
      link: { fontSize: 12, background: 'none', border: 'none', padding: 0, color: 'inherit', opacity: 0.66, cursor: 'pointer', textDecoration: 'underline' },
    }

    return function ObservationPackCard() {
      const snapshot = React.useSyncExternalStore(
        (listener) => form.subscribe(listener),
        () => form.getSnapshot(),
      )
      const [drafts, setDrafts] = React.useState({})
      const [resets, setResets] = React.useState({})
      const [fence, setFence] = React.useState(undefined)
      const [saving, setSaving] = React.useState(false)
      const [failure, setFailure] = React.useState(undefined)

      const value = snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {}
      const user = snapshot.user !== null && typeof snapshot.user === 'object' ? snapshot.user : {}
      const stagedKeys = [...Object.keys(drafts), ...Object.keys(resets)]
      const dirty = stagedKeys.length > 0

      /** 读取某字段当前应显示的草稿：优先本地草稿，否则回落到已保存值。 */
      function draftOf(field) {
        if (Object.hasOwn(drafts, field.key)) return drafts[field.key]
        return toDraft(field, value[field.key])
      }

      function edit(field, next) {
        if (fence === undefined) setFence(snapshot.revision)
        setResets((current) => {
          if (!Object.hasOwn(current, field.key)) return current
          const copy = { ...current }
          delete copy[field.key]
          return copy
        })
        setDrafts((current) => ({ ...current, [field.key]: next }))
      }

      /** 标记该字段恢复默认：写回时发 unset，让它重新继承部署层与 schema 默认值。 */
      function restore(field) {
        if (fence === undefined) setFence(snapshot.revision)
        setDrafts((current) => {
          if (!Object.hasOwn(current, field.key)) return current
          const copy = { ...current }
          delete copy[field.key]
          return copy
        })
        setResets((current) => ({ ...current, [field.key]: true }))
      }

      function discard() {
        setDrafts({})
        setResets({})
        setFence(undefined)
        setFailure(undefined)
      }

      async function save() {
        const ops = []
        for (const key of Object.keys(resets)) ops.push({ op: 'unset', path: [key] })
        for (const key of Object.keys(drafts)) {
          const field = FIELDS.find((f) => f.key === key)
          if (field === undefined) continue
          ops.push({ op: 'set', path: [key], value: toValue(field, drafts[key]) })
        }
        if (ops.length === 0) {
          discard()
          return
        }
        setSaving(true)
        setFailure(undefined)
        try {
          await form.mutate(ops, fence)
          setDrafts({})
          setResets({})
          setFence(undefined)
        } catch (error) {
          setFailure(error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error))
        } finally {
          setSaving(false)
        }
      }

      const blocked =
        snapshot.writable === false ||
        saving ||
        FIELDS.some((field) => Object.hasOwn(drafts, field.key) && isInvalid(field, drafts[field.key]))

      const rows = FIELDS.map((field) => {
        const draft = draftOf(field)
        const overridden = isOverridden(user, field.key)
        const control =
          field.kind === 'boolean'
            ? h('input', {
                type: 'checkbox',
                checked: draft === true,
                disabled: snapshot.writable === false || saving,
                onChange: (event) => edit(field, event.target.checked),
              })
            : h('input', {
                type: field.kind === 'number' ? 'number' : 'text',
                style: { ...S.input, width: field.kind === 'list' ? 320 : 160 },
                value: draft,
                disabled: snapshot.writable === false || saving,
                onChange: (event) => edit(field, event.target.value),
              })

        return h(
          'div',
          { key: field.key, style: S.row },
          h(
            'div',
            { style: S.rowHead },
            h('span', { style: S.label }, field.label),
            overridden
              ? h(
                  'span',
                  null,
                  h('span', { style: S.badge }, '已覆盖'),
                  ' ',
                  h('button', { type: 'button', style: S.link, onClick: () => restore(field) }, '恢复默认'),
                )
              : null,
          ),
          h('p', { style: S.hint }, field.hint),
          h(
            'div',
            { style: S.control },
            control,
            field.kind === 'number' && isInvalid(field, draft) ? h('span', { style: S.error }, '需要非负整数') : null,
          ),
        )
      })

      return h(
        'div',
        { style: S.card },
        h('h3', { style: S.title }, '观测打包（ObservationPack）'),
        h(
          'p',
          { style: S.intro },
          '把被反复回放的大工具结果替换成一个稳定的 handle：原文逐字节归档到本地 spill 存储，模型改用 read 工具按 offset/limit 分页召回。',
          h('br'),
          '机制来源是 NVIDIA SoL-Pi 的 ObservationPack，但按 DSH 的「可重放表面替换」重写——模型看到替换副本，你的对话记录仍保留原文。',
        ),
        snapshot.status !== undefined && snapshot.status !== 'ready'
          ? h('p', { style: S.muted }, snapshot.status === 'loading' ? '正在读取设置…' : String(snapshot.status))
          : null,
        rows,
        h(
          'div',
          { style: S.actions },
          h(
            'button',
            { type: 'button', style: blocked ? S.button : S.buttonPrimary, disabled: blocked, onClick: save },
            saving ? '保存中…' : '保存',
          ),
          h('button', { type: 'button', style: S.button, disabled: !dirty || saving, onClick: discard }, '放弃更改'),
          failure !== undefined ? h('span', { style: S.error }, `保存失败：${failure}`) : null,
          snapshot.writable === false ? h('span', { style: S.muted }, '当前部署的设置不可写') : null,
        ),
      )
    }
  }

  const target = globalThis.window === undefined ? undefined : globalThis.window.__ModuleLoader__
  if (target === undefined) {
    throw new Error(`${PACKAGE}: window.__ModuleLoader__ is missing — this bundle is served by the DSH web shell and cannot be loaded directly`)
  }

  target.load({
    id: PACKAGE,
    factory: (require) => {
      const React = require('react')

      /**
       * 在调用方插件的生命周期上挂载设置页面。
       * @param ctx - 浏览器插件上下文。
       */
      function apply(ctx) {
        // 表单归 `configForms` 服务所有、按 entry id 共享：消费者只用
        // getSnapshot() / subscribe() / mutate()，**不 dispose**——拆掉的是别人的表单，
        // 释放自己的订阅是 subscribe() 返回的那个函数。
        const form = ctx.configForms.get(NAMESPACE)
        // 注册为【设置页左侧导航里的独立菜单】(`settings.section`)，
        // 而不是「插件 → 插件配置」里的一张卡片 (`settings.plugin.item`)。
        // 本仓库约定：每个插件的配置只放左侧独立菜单这一处。
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: NAMESPACE, order: 16, label: '观测打包' },
            createCard(React, form),
          ),
        )
      }

      return { inject: ['slots', 'configForms'], apply }
    },
  })
})()
