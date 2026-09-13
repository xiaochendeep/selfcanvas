import { ArrowDownToLine, ArrowRight, Check, ChevronDown, Clapperboard, FileText, Image, Info, LoaderCircle, RefreshCw, ScanEye, Sparkles, Video, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { catalogModels, verifiedAnyCapCatalog } from '../services/anycapCatalog';
import {
  createCreativeActionLock, createCreativeRequestId, creativeDraftIssue, creativeImageBatchAction, creativeIntegerInput, editCreativeDraft, editCreativeShot, getCreativeCapabilities, runCreative,
  type CreativeCapabilities, type CreativeDraft, type CreativeKind, type CreativeRunRequest, type CreativeRunResult, type CreativeShot,
} from '../services/creativeStudioClient';
import { useCanvasStore } from '../store/canvasStore';
import '../creative-studio.css';

const modes = [
  { kind: 'script', label: '一键剧本', detail: '想法 → 可编辑剧本', icon: FileText },
  { kind: 'storyboard', label: '图片分镜', detail: '剧本 → 镜头与提示词', icon: Clapperboard },
  { kind: 'video-analysis', label: '视频爆点', detail: '素材 → 时间点与启发', icon: ScanEye },
] as const;
const starterIdeas = ['30 秒悬疑短剧，结尾留下反转', '15 秒产品短片，用一个动作讲清卖点', '温暖的生活故事，人物少、场景集中'];
const imageModels = (catalogModels(verifiedAnyCapCatalog, 'image') ?? []).filter((model) => ['nano-banana-2', 'nano-banana-pro', 'gpt-image-2'].includes(model.id));
const videoModels = catalogModels(verifiedAnyCapCatalog, 'video') ?? [];

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="creative-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function EditableDraft({ result, onChange, readOnly }: { result: CreativeRunResult; onChange: (result: CreativeRunResult) => void; readOnly: boolean }) {
  const draft = result.draft;
  const update = (patch: Partial<CreativeDraft>) => onChange(editCreativeDraft(result, patch));
  return <>
    <Field label="标题"><input readOnly={readOnly} aria-label="草稿标题" value={draft.title} onChange={(event) => update({ title: event.target.value })} /></Field>
    {draft.kind === 'script' && <>
      <Field label="故事梗概"><textarea readOnly={readOnly} rows={2} value={draft.logline} onChange={(event) => update({ logline: event.target.value })} /></Field>
      <Field label="剧本正文" hint={readOnly ? '当前草稿只读，仍可选字复制。' : '这里可直接选字、复制、剪切与粘贴。'}><textarea readOnly={readOnly} className="creative-script-editor" aria-label="剧本正文" value={draft.script} onChange={(event) => update({ script: event.target.value })} /></Field>
      <details className="creative-details"><summary>人物与创作锚点 <ChevronDown size={14} /></summary>
        <div className="creative-anchor-grid">{Object.entries(draft.anchors).map(([key, value]) => <div key={key}><small>{({ emotion: '情感', motif: '母题', prop: '关键道具', turn: '转折', finalImage: '终场画面' } as Record<string, string>)[key]}</small><p>{value}</p></div>)}</div>
        {draft.characters.map((character, index) => <p key={index}><strong>{character.name}</strong> · {character.description}</p>)}
        {draft.beats.map((beat, index) => <p key={`beat-${index}`}><strong>{index + 1}. {beat.title}</strong> · {beat.action} → {beat.consequence}</p>)}
      </details>
    </>}
    {draft.kind === 'storyboard' && <>
      <div className="creative-inline-note"><Image size={16} /><span>以下是分镜提示词，尚未生成图片。文字一致性不等于参考图锁定；出图前可在节点绑定角色素材，再单独确认批量生图。</span></div>
      <div className="creative-shot-list">{draft.shots.map((shot, index) => {
        const patch = (next: Partial<CreativeShot>) => onChange(editCreativeShot(result, index, next));
        return <article className="creative-shot" key={shot.shotNumber}>
          <header><span className="creative-shot-number">{String(shot.shotNumber).padStart(2, '0')}</span><div><strong>{shot.shotSize || '镜头'}</strong><small>{shot.function}</small></div><span>{shot.durationSeconds}s</span></header>
          <Field label="画面 / 可见动作"><textarea readOnly={readOnly} rows={3} value={shot.visualDescription} onChange={(event) => patch({ visualDescription: event.target.value })} /></Field>
          <Field label="图片提示词"><textarea readOnly={readOnly} rows={4} value={shot.imagePrompt} onChange={(event) => patch({ imagePrompt: event.target.value })} /></Field>
          <details className="creative-details"><summary>视频提示词与连续性 <ChevronDown size={14} /></summary>
            <Field label="视频提示词"><textarea readOnly={readOnly} rows={4} value={shot.videoPrompt} onChange={(event) => patch({ videoPrompt: event.target.value })} /></Field>
            <div className="creative-anchor-grid"><div><small>镜头运动</small><p>{shot.cameraMovement}</p></div><div><small>光线 / 声音</small><p>{shot.lighting} · {shot.sound}</p></div><div><small>连续性</small><p>{shot.continuity}</p></div><div><small>结束画面</small><p>{shot.finalFrame}</p></div></div>
          </details>
        </article>;
      })}</div>
      {!!draft.reviewNotes.length && <div className="creative-notes"><strong>分镜检查</strong>{draft.reviewNotes.map((note, index) => <p key={index}>{note}</p>)}</div>}
    </>}
    {draft.kind === 'video-analysis' && <>
      <Field label="内容摘要"><textarea readOnly={readOnly} rows={3} value={draft.summary} onChange={(event) => update({ summary: event.target.value })} /></Field>
      <Field label="开场钩子"><textarea readOnly={readOnly} rows={3} value={draft.openingHook} onChange={(event) => update({ openingHook: event.target.value })} /></Field>
      <div className="creative-analysis-list">{draft.segments.map((segment, index) => <article key={index}>
        <header><span>{segment.startSeconds}s — {segment.endSeconds}s</span><small>置信度 {Math.round(segment.confidence * 100)}%</small></header>
        <p>{segment.observation}</p><strong>{segment.appeal}</strong><p className="creative-muted">{segment.technique}</p>
      </article>)}</div>
      <Field label="可借鉴的改编方向" hint="每行一个方向；借鉴叙事方法，不直接复制他人素材。"><textarea readOnly={readOnly} rows={4} value={draft.adaptationIdeas.join('\n')} onChange={(event) => update({ adaptationIdeas: event.target.value.split('\n') })} /></Field>
      <div className="creative-notes"><strong>分析边界</strong><p>爆点是内容吸引力推断，不等同于真实流量、留存或爆款保证。</p>{draft.limitations.map((note, index) => <p key={index}>{note}</p>)}</div>
    </>}
  </>;
}

export function CreativeStudioPanel({ onClose }: { onClose: () => void }) {
  const activeCanvas = useCanvasStore((state) => state.activeCanvas);
  const importCreativeDraft = useCanvasStore((state) => state.importCreativeDraft);
  const [kind, setKind] = useState<CreativeKind>('script');
  const [capabilities, setCapabilities] = useState<CreativeCapabilities | null>(null);
  const [loadingCapabilities, setLoadingCapabilities] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [brief, setBrief] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [sourceTextNodeId, setSourceTextNodeId] = useState('');
  const [sourceNodeId, setSourceNodeId] = useState('');
  const [shotCount, setShotCount] = useState('6');
  const [duration, setDuration] = useState('30');
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16' | '1:1'>('9:16');
  const [style, setStyle] = useState('真人电影感');
  const [imageModel, setImageModel] = useState('nano-banana-2');
  const [videoModel, setVideoModel] = useState('seedance-2.5');
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<CreativeRunResult | null>(null);
  const targetCanvasName = useCanvasStore((state) => state.project.canvases.find((canvas) => canvas.id === result?.canvasId)?.name);
  const [failedRequest, setFailedRequest] = useState<CreativeRunRequest | null>(null);
  const [retryConfirmed, setRetryConfirmed] = useState(false);
  const [closeConfirmed, setCloseConfirmed] = useState(false);
  const [imported, setImported] = useState<{ nodeIds: string[]; imageNodeIds: string[] } | null>(null);
  const [batchConfirm, setBatchConfirm] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchProgress, setBatchProgress] = useState('');
  const [completedImageIds, setCompletedImageIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [capabilityError, setCapabilityError] = useState('');
  const [notice, setNotice] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const batchStopRef = useRef(false);
  const actionLock = useRef(createCreativeActionLock());
  const currentMode = modes.find((mode) => mode.kind === kind)!;
  const capability = capabilities?.skills.find((skill) => skill.kind === kind);
  const retryCapability = capabilities?.skills.find((skill) => skill.kind === failedRequest?.kind);
  const maxText = capabilities?.limits.maxTextChars || 24000;
  const maxShots = Math.min(20, capabilities?.limits.maxShots || 20);
  const busy = pending || importing || batchBusy;
  const videos = useMemo(() => activeCanvas.nodes.filter((node) => Boolean(node.data.outputs?.videoUrl || node.data.importedMedia?.type === 'video')), [activeCanvas.nodes]);
  const scriptNodes = useMemo(() => activeCanvas.nodes.filter((node) => node.data.kind === 'text' && Boolean(node.data.outputs?.text || node.data.prompt)), [activeCanvas.nodes]);
  const draftIssue = result ? creativeDraftIssue(result.draft) : '';

  useEffect(() => {
    const controller = new AbortController();
    setLoadingCapabilities(true);
    getCreativeCapabilities(controller.signal).then((value) => { if (!controller.signal.aborted) { setCapabilities(value); setCapabilityError(''); } })
      .catch((reason) => { if (!controller.signal.aborted) { setCapabilities(null); setCapabilityError(reason instanceof Error ? reason.message : '无法读取创作能力'); } })
      .finally(() => { if (!controller.signal.aborted) setLoadingCapabilities(false); });
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.focus();
    return () => { batchStopRef.current = true; if (previous instanceof HTMLElement) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { if (!videos.some((node) => node.id === sourceNodeId)) setSourceNodeId(''); }, [videos, sourceNodeId]);
  useEffect(() => { if (!scriptNodes.some((node) => node.id === sourceTextNodeId)) setSourceTextNodeId(''); }, [scriptNodes, sourceTextNodeId]);

  const selectMode = (next: CreativeKind) => { setKind(next); setConfirmed(false); setError(''); setNotice(''); };
  const changeResult = (next: CreativeRunResult) => { setResult(next); setBatchConfirm(false); };
  const requestClose = () => {
    if (busy || actionLock.current.isActive()) return;
    if ((result && !imported) || failedRequest) { setCloseConfirmed(true); return; }
    onClose();
  };
  const run = async (retryRequest?: CreativeRunRequest) => {
    const allowed = retryRequest ? retryConfirmed && retryCapability?.available : confirmed && capability?.available;
    if (busy || !allowed || loadingCapabilities) return;
    if (!retryRequest && !brief.trim() && kind !== 'video-analysis') { setError('请先描述创作目标'); return; }
    if (!retryRequest && brief.length > Math.min(8000, maxText)) { setError('创作简述过长，请精简后再生成'); return; }
    if (!retryRequest && kind === 'storyboard' && !sourceText.trim()) { setError('请填写或选择要拆解的剧本'); return; }
    if (!retryRequest && kind === 'storyboard' && sourceText.length > maxText) { setError(`剧本超过 ${maxText.toLocaleString()} 字，请按场次拆分后生成分镜`); return; }
    if (!retryRequest && kind === 'video-analysis' && !sourceNodeId) { setError('请从当前画布选择一个视频素材'); return; }
    const parsedDuration = creativeIntegerInput(duration, 5, 600);
    const parsedShotCount = creativeIntegerInput(shotCount, 1, maxShots);
    if (!retryRequest && kind !== 'video-analysis' && parsedDuration === null) { setError('目标时长请输入 5–600 之间的整数'); return; }
    if (!retryRequest && kind === 'storyboard' && parsedShotCount === null) { setError(`镜头数请输入 1–${maxShots} 之间的整数`); return; }
    const request: CreativeRunRequest = retryRequest || {
      kind, requestId: createCreativeRequestId(), confirmed: true, canvasId: activeCanvas.id,
      brief: brief.trim() || '分析开场钩子、情绪转折、节奏变化与可借鉴的叙事技巧',
      sourceText: kind === 'storyboard' ? sourceText : undefined,
      sourceNodeId: kind === 'video-analysis' ? sourceNodeId : undefined,
      shotCount: parsedShotCount ?? 6, durationSeconds: parsedDuration ?? 30, aspectRatio, style, imageModel, videoModel,
    };
    if (!actionLock.current.acquire()) return;
    setPending(true); setCloseConfirmed(false); setError(''); setNotice('');
    try {
      const next = await runCreative(request);
      setResult(next); setFailedRequest(null); setImported(null); setCompletedImageIds([]); setBatchConfirm(false); setNotice('草稿已生成。请预览、修改，再决定是否加入画布。');
    } catch (reason) { setFailedRequest(request); setError(reason instanceof Error ? reason.message : '创作失败'); }
    finally { actionLock.current.release(); setPending(false); setConfirmed(false); setRetryConfirmed(false); }
  };
  const addToCanvas = async () => {
    if (!result || busy || imported || draftIssue || !actionLock.current.acquire()) return;
    setImporting(true); setCloseConfirmed(false); setError('');
    try {
      const nodes = await importCreativeDraft(result);
      setImported(nodes); setNotice(`已加入 ${nodes.nodeIds.length} 个节点。${nodes.imageNodeIds.length ? '图片仍是待生成提示词，尚未调用生图模型。' : ''}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '加入画布失败，原画布未覆盖'); }
    finally { actionLock.current.release(); setImporting(false); }
  };
  const generateImages = async () => {
    if (!result || !imported?.imageNodeIds.length || !batchConfirm || busy || !actionLock.current.acquire()) return;
    batchStopRef.current = false; setBatchBusy(true); setCloseConfirmed(false); setError('');
    let completed = completedImageIds.length;
    try {
      for (const nodeId of imported.imageNodeIds.filter((id) => !completedImageIds.includes(id))) {
        if (batchStopRef.current) break;
        const state = useCanvasStore.getState();
        if (state.activeCanvas.id !== result.canvasId) throw new Error('当前画布已切换，剩余图片未提交');
        const candidate = state.activeCanvas.nodes.find((node) => node.id === nodeId);
        if (!candidate) throw new Error('分镜节点已被删除，剩余图片未提交');
        const action = creativeImageBatchAction(candidate.data);
        if (action === 'review') throw new Error('分镜节点已有任务记录或失败状态。请先在任务列表核实，并从该节点手动重试；批量操作不会重复提交可能已计费的任务。');
        if (action === 'skip') {
          completed += 1;
          setCompletedImageIds((ids) => ids.includes(nodeId) ? ids : [...ids, nodeId]);
          continue;
        }
        setBatchProgress(`正在生成 ${completed + 1} / ${imported.imageNodeIds.length}`);
        await state.runNode(nodeId);
        const node = useCanvasStore.getState().project.canvases.find((canvas) => canvas.id === result.canvasId)?.nodes.find((item) => item.id === nodeId);
        if (node?.data.status !== 'success') throw new Error(node?.data.error || '当前图片尚未成功，已暂停后续提交；请到任务列表检查');
        completed += 1;
        setCompletedImageIds((ids) => ids.includes(nodeId) ? ids : [...ids, nodeId]);
      }
      setNotice(`已完成 ${completed} / ${imported.imageNodeIds.length} 张分镜图片${batchStopRef.current ? '，已停止后续提交' : ''}。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '批量生图已暂停'); }
    finally { actionLock.current.release(); setBatchBusy(false); setBatchConfirm(false); setBatchProgress(''); }
  };
  const handleKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape' && !busy) { event.preventDefault(); if (closeConfirmed) setCloseConfirmed(false); else requestClose(); }
    if (event.key !== 'Tab') return;
    const fields = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]') ?? []).filter((element) => element.getClientRects().length > 0);
    const first = fields[0]; const last = fields[fields.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };

  return <div className="creative-studio-backdrop nodrag nowheel nopan" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
    <section className="creative-studio" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="creative-studio-title" aria-busy={busy} onKeyDown={handleKeyboard} onPaste={(event) => event.stopPropagation()} onCopy={(event) => event.stopPropagation()} onCut={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
      <header className="creative-studio-header"><div className="creative-studio-brand"><span><Sparkles size={23} /></span><div><h2 id="creative-studio-title">创作助手</h2><p>从想法到剧本，再到画面</p></div></div><span className="creative-preview-badge">SKILL WORKSPACE</span><button className="creative-icon-button" type="button" aria-label="关闭创作助手" disabled={busy} title={busy ? '任务处理期间请保持窗口打开' : '关闭'} onClick={requestClose}><X size={21} /></button></header>
      {closeConfirmed && <div className="creative-close-warning" role="alert"><p>关闭会清除未加入画布的草稿和重试记录。确认关闭？</p><button type="button" className="creative-secondary" onClick={() => setCloseConfirmed(false)}>继续编辑</button><button type="button" className="creative-secondary" disabled={busy} onClick={onClose}>确认关闭</button></div>}
      <nav className="creative-mode-tabs" aria-label="创作能力">{modes.map(({ kind: id, label, detail, icon: Icon }) => <button type="button" key={id} aria-pressed={kind === id} disabled={busy} className={kind === id ? 'is-active' : ''} onClick={() => selectMode(id)}><Icon size={20} /><span><strong>{label}</strong><small>{detail}</small></span></button>)}</nav>
      <div className="creative-studio-body">
        <aside className="creative-brief-column"><div className="creative-column-heading"><span>01</span><h3>告诉我你的创作目标</h3></div>
          <div className={`creative-gateway-state ${capability?.available ? 'is-ready' : ''}`}><div><i /><strong>{loadingCapabilities ? '检查创作网关…' : capability?.available ? '网关已配置 · 待验证调用' : '等待接入创作网关'}</strong><button className="creative-icon-button" type="button" aria-label="刷新创作网关状态" disabled={loadingCapabilities || busy} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={14} className={loadingCapabilities ? 'creative-spin' : ''} /></button></div><p>{capability?.model || '模型由服务器统一配置'}</p>{(!capability?.available || capabilityError) && <small>{capabilityError || capability?.reason || '将文本 / Gemini 视频理解模型接入服务器网关后，即可在这里使用。无需在浏览器填写 API Key。'}</small>}</div>
          {kind === 'video-analysis' && <Field label="当前画布的视频" hint="仅发送你主动选择的视频；服务端会验证素材归属与大小。"><select aria-label="待分析视频" value={sourceNodeId} onChange={(event) => setSourceNodeId(event.target.value)} disabled={busy}><option value="">{videos.length ? '选择视频素材' : '画布中还没有视频素材'}</option>{videos.map((node) => <option key={node.id} value={node.id}>{node.data.title} · {node.id.slice(-6)}</option>)}</select></Field>}
          <Field label={kind === 'video-analysis' ? '你想重点分析什么？' : '创作简述'}><textarea className="creative-brief-input" aria-label="创作简述" maxLength={Math.min(8000, maxText)} disabled={busy} value={brief} onChange={(event) => setBrief(event.target.value)} placeholder={kind === 'script' ? '讲什么故事？面向谁？想让观众产生什么感受？' : kind === 'storyboard' ? '例如：保持人物与场景一致，用明确动作推进故事，逐镜拆解。' : '例如：找出前 3 秒钩子、节奏转折和最有吸引力的时间点。'} /></Field>
          {kind === 'script' && !brief && <div className="creative-idea-chips">{starterIdeas.map((idea) => <button key={idea} type="button" onClick={() => setBrief(idea)}>{idea}<ArrowRight size={13} /></button>)}</div>}
          {kind === 'storyboard' && <>
            <Field label="剧本来源"><select value={sourceTextNodeId} aria-label="选择画布剧本" disabled={busy} onChange={(event) => { setSourceTextNodeId(event.target.value); const node = scriptNodes.find((item) => item.id === event.target.value); if (node) setSourceText(node.data.outputs?.text || node.data.prompt || ''); }}><option value="">手动粘贴，或选择画布文本</option>{scriptNodes.map((node) => <option key={node.id} value={node.id}>{node.data.title} · {node.id.slice(-6)}</option>)}</select></Field>
            <Field label="待拆解剧本" hint={`${sourceText.length.toLocaleString()} / ${maxText.toLocaleString()} 字${sourceText.length > maxText ? ' · 已超出限制，请按场次拆分' : ''}`}><textarea rows={6} aria-label="待拆解剧本" aria-invalid={sourceText.length > maxText} maxLength={maxText} disabled={busy} value={sourceText} onChange={(event) => { setSourceText(event.target.value); setSourceTextNodeId(''); }} placeholder="粘贴剧本正文；也可从右侧剧本草稿一键接续。" /></Field>
          </>}
          {kind !== 'video-analysis' && <>
            <div className="creative-form-row"><Field label="目标时长"><input type="number" min={5} max={600} step={1} aria-label="目标时长秒" value={duration} disabled={busy} onChange={(event) => setDuration(event.target.value)} /><small>秒 · 成片总时长</small></Field><Field label="画幅"><select aria-label="创作画幅" value={aspectRatio} disabled={busy} onChange={(event) => setAspectRatio(event.target.value as typeof aspectRatio)}><option>9:16</option><option>16:9</option><option>1:1</option></select></Field></div>
            <Field label="视觉方向"><input value={style} maxLength={300} disabled={busy} onChange={(event) => setStyle(event.target.value)} placeholder="例如：真人电影、二维动画、写实产品" /></Field>
          </>}
          {kind === 'storyboard' && <><div className="creative-form-row"><Field label="镜头数"><input type="number" min={1} max={maxShots} step={1} value={shotCount} disabled={busy} onChange={(event) => setShotCount(event.target.value)} /></Field><Field label="图片模型"><select value={imageModel} disabled={busy} onChange={(event) => setImageModel(event.target.value)}>{imageModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></Field></div><Field label="视频提示词适配模型"><select value={videoModel} disabled={busy} onChange={(event) => setVideoModel(event.target.value)}>{videoModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></Field></>}
          <div className="creative-run-area"><label className="creative-checkbox"><input type="checkbox" checked={confirmed} disabled={busy || loadingCapabilities || !capability?.available} onChange={(event) => setConfirmed(event.target.checked)} /><span>确认调用网关模型{kind === 'video-analysis' ? '分析所选视频' : '生成草稿'}，可能产生费用；不自动生成媒体。</span></label><button className="creative-primary" type="button" disabled={busy || loadingCapabilities || !confirmed || !capability?.available} onClick={() => run()}>{pending ? <LoaderCircle className="creative-spin" size={18} /> : <Sparkles size={18} />}{pending ? '创作中，请保持窗口打开…' : failedRequest ? '按当前内容发起新请求' : `生成${currentMode.label === '视频爆点' ? '视频分析' : currentMode.label === '一键剧本' ? '剧本草稿' : '分镜草稿'}`}</button></div>
        </aside>
        <main className="creative-draft-column"><div className="creative-draft-heading"><div className="creative-column-heading"><span>02</span><h3>{result ? `${modes.find((mode) => mode.kind === result.kind)?.label} · 预览与修改` : '你的创作，从这里展开'}</h3></div>{result && <span className="creative-draft-state">{imported ? '已加入画布' : '未加入画布'}</span>}</div>
          <div className="creative-draft-scroll">
            {error && <div className="creative-message is-error" role="alert">{error}</div>}{notice && <div className="creative-message" role="status">{notice}</div>}
            {failedRequest && <div className="creative-notes"><strong>{modes.find((mode) => mode.kind === failedRequest.kind)?.label} · 上次请求未取得结果</strong><p>按原请求 ID 和原参数重试，不使用左侧当前内容。发起新请求可能再次计费。</p><label className="creative-checkbox"><input type="checkbox" checked={retryConfirmed} disabled={busy || loadingCapabilities || !retryCapability?.available} onChange={(event) => setRetryConfirmed(event.target.checked)} /><span>确认重试这次{modes.find((mode) => mode.kind === failedRequest.kind)?.label}请求。</span></label><button className="creative-secondary" type="button" disabled={busy || loadingCapabilities || !retryConfirmed || !retryCapability?.available} onClick={() => run(failedRequest)}>按原请求重试</button></div>}
            {!result ? <div className="creative-empty"><div><Clapperboard size={40} /></div><h3>先打磨想法，再交给画布</h3><p>剧本、镜头卡与分析结论会出现在这里。<br />你可以先改好文字，再确认加入画布。</p><div className="creative-empty-flow"><span><FileText size={18} />剧本</span><ArrowRight size={15} /><span><Image size={18} />分镜</span><ArrowRight size={15} /><span><Video size={18} />视频</span></div></div> : <>
              {kind !== result.kind && <div className="creative-inline-note"><Info size={15} /><span>左侧正在设置{currentMode.label}，这里保留的是上一次{modes.find((mode) => mode.kind === result.kind)?.label}草稿。</span></div>}
              <div className="creative-result-meta"><span>{result.model}<br />目标画布：{targetCanvasName || '画布已不存在'}</span><small>{result.draft.kind === 'storyboard' ? `${result.draft.shots.length} 个镜头` : result.draft.kind === 'video-analysis' ? `${result.draft.segments.length} 个关键片段` : `${result.draft.script.length} 字`}</small></div>
              <div className="creative-editable-result"><EditableDraft result={result} onChange={changeResult} readOnly={Boolean(imported) || busy} /></div>
              {!!result.warnings.length && <div className="creative-notes"><strong>需要留意</strong>{result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
              <details className="creative-details creative-sources"><summary>能力来源与版本 <ChevronDown size={14} /></summary><p>Image / Video Skill · Serge Shima · CC BY 4.0</p>{result.skillSources.map((source, index) => <p key={index}>{source}</p>)}<p>参考模型能力以网关与 AnyCap 实际提供的参数为准。</p></details>
            </>}
          </div>
          <footer className="creative-draft-footer">{result ? <>
            {draftIssue && <p className="creative-muted">{draftIssue}</p>}
            {result.draft.kind === 'script' && <button className="creative-secondary" type="button" disabled={busy} onClick={() => { setSourceText(result.draft.kind === 'script' ? result.draft.script : ''); setSourceTextNodeId(''); setBrief('依据剧本拆解图片分镜，保证人物、场景与动作连续。'); selectMode('storyboard'); }}>继续做图片分镜<ArrowRight size={16} /></button>}
            {!imported ? <button className="creative-primary" type="button" disabled={busy || Boolean(draftIssue) || !targetCanvasName} onClick={addToCanvas}>{importing ? <LoaderCircle className="creative-spin" size={17} /> : <ArrowDownToLine size={17} />}加入画布</button> : <span className="creative-imported"><Check size={17} />已加入 {imported.nodeIds.length} 个节点</span>}
            {!!imported?.imageNodeIds.length && <div className="creative-batch-area"><label className="creative-checkbox"><input type="checkbox" checked={batchConfirm} disabled={busy || completedImageIds.length === imported.imageNodeIds.length} onChange={(event) => setBatchConfirm(event.target.checked)} /><span>确认通过现有 AnyCap 配置生成剩余 {imported.imageNodeIds.length - completedImageIds.length} 张图片，按模型计费。</span></label>{batchBusy ? <><span role="status">{batchProgress}</span><button className="creative-secondary" type="button" onClick={() => { batchStopRef.current = true; setNotice('当前图片会继续完成；之后不再提交新的生图请求。'); }}>停止后续提交</button></> : <button className="creative-primary" type="button" disabled={!batchConfirm || busy || completedImageIds.length === imported.imageNodeIds.length || activeCanvas.id !== result.canvasId} onClick={generateImages}><Image size={17} />生成分镜图片</button>}</div>}
          </> : <p><Info size={15} /> 生成草稿不会修改现有节点或自动发送媒体任务。</p>}</footer>
        </main>
      </div>
    </section>
  </div>;
}
