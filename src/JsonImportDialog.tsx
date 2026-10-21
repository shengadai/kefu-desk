import { useEffect, useRef, useState } from 'react'
import { Check, ShieldCheck, Upload, X } from 'lucide-react'
import type { JsonImportPreview } from './json-import'
import type { Phrase, Scope } from './types'

const scopeNames: Record<Scope, string> = { company: '公司共享', group: '小组共享', private: '私人' }

function PreviewContent({ phrase }: { phrase: Phrase }) {
  const images = phrase.images?.length ? phrase.images : phrase.image ? [phrase.image] : []
  return <>
    {phrase.text && <p className="json-import-text">{phrase.text}</p>}
    {images.length > 0 && <div className="json-import-images">{images.map((image, index) => <img key={index} src={image} loading="lazy" alt={`图片附件 ${index + 1}`} />)}<span>{images.length} 张图片</span></div>}
  </>
}

export default function JsonImportDialog({ filename, preview, videoReferences, canConfirm, onCancel, onConfirm }: {
  filename: string
  preview: JsonImportPreview
  videoReferences: number
  canConfirm: boolean
  onCancel: () => void
  onConfirm: (selectedIndices: number[]) => void
}) {
  const [selected, setSelected] = useState(() => new Set(preview.candidates.map((candidate) => candidate.sourceIndex)))
  const dialogRef = useRef<HTMLElement>(null)
  const selectedIndices = preview.candidates.filter((candidate) => selected.has(candidate.sourceIndex)).map((candidate) => candidate.sourceIndex)
  const allSelected = preview.candidates.length > 0 && selectedIndices.length === preview.candidates.length
  const duplicateCount = preview.existingDuplicates + preview.fileDuplicates

  useEffect(() => {
    const previousFocus = document.activeElement
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus() }
  }, [])

  return <div className="modal-backdrop json-import-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>
    <section ref={dialogRef} className="json-import-modal" role="dialog" aria-modal="true" aria-labelledby="json-import-title" aria-describedby="json-import-rule" onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); onCancel() }
      if (event.key !== 'Tab') return
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary')
      if (!controls?.length) return
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }}>
      <div className="modal-heading"><div><span className="modal-eyebrow">JSON · 合并导入</span><h2 id="json-import-title">确认新增话术</h2><p className="json-import-filename" title={filename}>{filename}</p></div><button type="button" className="icon-button" onClick={onCancel} aria-label="关闭导入预览"><X size={18} /></button></div>
      <div className="json-import-summary" aria-live="polite"><strong>此次发现 <b>{preview.candidates.length}</b> 条不同话术</strong><span>重复 {duplicateCount} 条，自动跳过；现有话术全部保留</span></div>
      <p className="json-import-rule" id="json-import-rule">按标题、文字和图片去重，忽略编号、时间、分类和快捷键变化。同名但内容不同的会另存为新话术，不覆盖原文。</p>
      {(videoReferences > 0 || preview.emptyPhrases > 0) && <p className="json-import-warning">{videoReferences > 0 && `JSON 不包含视频文件，${videoReferences} 个视频引用不会导入；完整恢复视频请使用 ZIP。`}{preview.emptyPhrases > 0 && ` 已跳过 ${preview.emptyPhrases} 条没有文字或图片的记录。`}</p>}
      {preview.candidates.length > 0 ? <>
        <div className="json-import-list-heading"><label><input type="checkbox" aria-label="全选待新增话术" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(preview.candidates.map((candidate) => candidate.sourceIndex)))} />全选新增内容</label><span>已选择 {selectedIndices.length} / {preview.candidates.length} 条</span></div>
        <div className="json-import-list" aria-label="待新增话术内容">{preview.candidates.map((candidate) => <article className={`json-import-item${selected.has(candidate.sourceIndex) ? ' is-checked' : ''}`} key={candidate.sourceIndex}>
          <div className="json-import-item-heading"><label><input type="checkbox" checked={selected.has(candidate.sourceIndex)} aria-label={`新增 ${candidate.phrase.title || '未命名话术'}`} onChange={() => setSelected((current) => {
            const next = new Set(current)
            if (next.has(candidate.sourceIndex)) next.delete(candidate.sourceIndex)
            else next.add(candidate.sourceIndex)
            return next
          })} /><strong>{candidate.phrase.title || '未命名话术'}</strong></label><span>{scopeNames[candidate.category.scope]} · {candidate.category.name}</span></div>
          <PreviewContent phrase={candidate.phrase} />
          {candidate.phrase.tags.length > 0 && <div className="card-tags">{candidate.phrase.tags.map((tag, index) => <span key={index}>{tag}</span>)}</div>}
          {candidate.existingPhrase && <details className="json-import-comparison"><summary>与已有话术不同 · 查看保留的原内容</summary><strong>{candidate.existingPhrase.title || '未命名话术'}</strong><PreviewContent phrase={candidate.existingPhrase} />{candidate.existingPhrase.videos?.length ? <p>原话术的 {candidate.existingPhrase.videos.length} 个视频附件保持不变</p> : null}</details>}
        </article>)}</div>
      </> : <div className="json-import-empty"><Check size={24} /><strong>{duplicateCount ? '没有需要新增的话术' : '文件中没有可新增的文字或图片话术'}</strong><p>{duplicateCount ? '相同内容已在话术库中保留，无需重复导入。' : '当前话术库不会发生任何改变。'}</p></div>}
      {!canConfirm && <p className="form-error" role="alert">工作区尚未就绪、正在同步或设备只读，暂时无法新增。</p>}
      <div className="modal-footer"><span><ShieldCheck size={14} />仅新增勾选项，不删除或覆盖</span><div><button type="button" className="button-quiet" onClick={onCancel}>{preview.candidates.length ? '取消' : '关闭'}</button>{preview.candidates.length > 0 && <button type="button" className="button-primary" disabled={!canConfirm || selectedIndices.length === 0} onClick={() => onConfirm(selectedIndices)}><Upload size={14} />确认新增 {selectedIndices.length} 条</button>}</div></div>
    </section>
  </div>
}
