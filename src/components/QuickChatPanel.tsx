import {
  Bot,
  FileStack,
  Image,
  KeyRound,
  Loader2,
  Paperclip,
  PenLine,
  Play,
  Send,
  Trash2,
  Video,
} from 'lucide-react';
import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useCanvasStore } from '../store/canvasStore';
import { useSettingsStore } from '../store/settingsStore';
import type { NodeKind, ProviderOptions } from '../types';

interface ChatImageAttachment {
  id: string;
  name: string;
  dataUrl: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images?: ChatImageAttachment[];
}

const CHAT_MODEL = 'gpt-5.5';
const runnableKinds = new Set<NodeKind>(['text', 'image', 'video']);

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function readImageFile(file: File): Promise<ChatImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        id: id('image'),
        name: file.name || 'image',
        dataUrl: String(reader.result || ''),
      });
    };
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

async function postChat(body: unknown): Promise<{ message: string; model?: string }> {
  const response = await fetch('/api/chat/sub2api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload.error || payload.message || `HTTP ${response.status}`));
  }
  return payload as { message: string; model?: string };
}

function nodePatchFor(kind: NodeKind, prompt: string): { model?: string; provider?: string; providerOptions?: ProviderOptions } {
  if (kind === 'text') {
    return {
      model: CHAT_MODEL,
      provider: 'Sub2API',
      providerOptions: { providerTool: 'sub2api', model: CHAT_MODEL, temperature: 0.7 },
    };
  }
  if (kind === 'image') {
    return {
      provider: 'Sub2API',
      providerOptions: {
        providerTool: 'sub2api',
        model: 'gpt-image-2',
        size: '1024x1024',
        resolutionTier: '1K',
        aspectRatio: 'adaptive',
        count: 1,
        responseFormat: 'url',
        outputFormat: 'png',
        transparentBackground: false,
        quality: 'standard',
        referenceQuality: 'high',
      },
    };
  }
  if (kind === 'video') {
    return {
      provider: 'AnyCap',
      providerOptions: {
        providerTool: 'anycap',
        model: 'seedance-2-fast',
        mode: 'multi-modal-reference',
        resolution: '720p',
        duration: 6,
        aspectRatio: 'adaptive',
        generateAudio: true,
        format: 'mp4',
      },
    };
  }
  return { providerOptions: { model: prompt ? 'local-asset' : undefined } };
}

function latestMessageText(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messages[index].content.trim();
    if (text) return text;
  }
  return '';
}

function nodeTitle(kind: NodeKind) {
  if (kind === 'text') return '聊天生成文本';
  if (kind === 'image') return '聊天生成图像';
  if (kind === 'video') return '聊天生成视频';
  return '聊天素材节点';
}

export function QuickChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: id('assistant'),
      role: 'assistant',
      content: '我可以用 Sub2API 的 gpt-5.5 聊天，也可以把当前输入交给画布节点生成。',
    },
  ]);
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState(CHAT_MODEL);
  const [attachments, setAttachments] = useState<ChatImageAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [nodeBusy, setNodeBusy] = useState<NodeKind | ''>('');
  const [notice, setNotice] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const providerDraft = useSettingsStore((state) => state.providerDrafts.sub2api);
  const setProviderDraft = useSettingsStore((state) => state.setProviderDraft);
  const addNode = useCanvasStore((state) => state.addNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const runNode = useCanvasStore((state) => state.runNode);
  const setQuickPanelOpen = useCanvasStore((state) => state.setQuickPanelOpen);

  const canSend = useMemo(() => Boolean(draft.trim() || attachments.length), [attachments.length, draft]);

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.currentTarget.files ?? [])].filter((file) => file.type.startsWith('image/')).slice(0, 6);
    event.currentTarget.value = '';
    if (!files.length) return;
    try {
      const loaded = await Promise.all(files.map(readImageFile));
      setAttachments((current) => [...current, ...loaded].slice(0, 6));
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const sendMessage = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend || busy) return;
    const userMessage: ChatMessage = {
      id: id('user'),
      role: 'user',
      content: draft.trim(),
      images: attachments,
    };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setDraft('');
    setAttachments([]);
    setBusy(true);
    setNotice('');
    try {
      const response = await postChat({
        endpoint: providerDraft.endpoint,
        apiKey: providerDraft.apiKey,
        model: model.trim() || CHAT_MODEL,
        messages: nextMessages.map((message) => ({
          role: message.role,
          content: message.content,
          images: message.images?.map((imageItem) => ({
            name: imageItem.name,
            dataUrl: imageItem.dataUrl,
          })),
        })),
      });
      setMessages((current) => [
        ...current,
        {
          id: id('assistant'),
          role: 'assistant',
          content: response.message,
        },
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: id('assistant'),
          role: 'assistant',
          content: `Sub2API 调用失败：${error instanceof Error ? error.message : String(error)}`,
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const promptForNode = () => draft.trim() || latestMessageText(messages) || '从右下角聊天创建的画布任务';

  const createCanvasNode = async (kind: NodeKind) => {
    if (nodeBusy) return;
    setNodeBusy(kind);
    setNotice('');
    const prompt = promptForNode();
    try {
      addNode(kind);
      const nodeId = useCanvasStore.getState().selectedNodeId;
      const patch = nodePatchFor(kind, prompt);
      if (kind === 'asset' && attachments[0]) {
        updateNodeData(nodeId, {
          title: '聊天图片素材',
          prompt: attachments[0].name,
          status: 'success',
          progress: 100,
          provider: 'Local',
          model: 'local-asset',
          outputs: { imageUrl: attachments[0].dataUrl, assetName: attachments[0].name },
        });
        setNotice('已把图片放进素材节点。');
        setQuickPanelOpen(false);
        return;
      }
      updateNodeData(nodeId, {
        title: nodeTitle(kind),
        prompt,
        ...patch,
      });
      if (runnableKinds.has(kind)) {
        await runNode(nodeId);
        setNotice('任务已提交到画布节点。');
      } else {
        setNotice('节点已添加到画布。');
      }
      setQuickPanelOpen(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setNodeBusy('');
    }
  };

  return (
    <section className="floating-panel quick-panel quick-chat-panel">
      <div className="quick-chat-head">
        <div>
          <span className="panel-kicker">Sub2API Chat</span>
          <h2>gpt-5.5 画布助手</h2>
        </div>
        <Bot size={21} />
      </div>

      <div className="quick-chat-provider">
        <label>
          <span>Base URL</span>
          <input
            value={providerDraft.endpoint}
            placeholder="http://10.0.0.239:3000"
            onChange={(event) => setProviderDraft('sub2api', { endpoint: event.currentTarget.value })}
          />
        </label>
        <label>
          <span>API Key</span>
          <input
            type="password"
            value={providerDraft.apiKey}
            placeholder="临时使用"
            onChange={(event) => setProviderDraft('sub2api', { apiKey: event.currentTarget.value })}
          />
        </label>
        <label>
          <span>模型</span>
          <input value={model} onChange={(event) => setModel(event.currentTarget.value)} />
        </label>
      </div>

      <div className="quick-chat-messages">
        {messages.map((message) => (
          <div className={`quick-chat-message is-${message.role}`} key={message.id}>
            <strong>{message.role === 'user' ? '你' : '助手'}</strong>
            {message.content && <p>{message.content}</p>}
            {message.images?.length ? (
              <div className="quick-chat-thumbs">
                {message.images.map((imageItem) => (
                  <img alt={imageItem.name} key={imageItem.id} src={imageItem.dataUrl} />
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {busy && (
          <div className="quick-chat-message is-assistant">
            <strong>助手</strong>
            <p className="quick-chat-loading">
              <Loader2 className="spin" size={14} />
              正在调用 Sub2API
            </p>
          </div>
        )}
      </div>

      {attachments.length ? (
        <div className="quick-chat-attachments">
          {attachments.map((imageItem) => (
            <button key={imageItem.id} type="button" onClick={() => setAttachments((current) => current.filter((item) => item.id !== imageItem.id))}>
              <img alt={imageItem.name} src={imageItem.dataUrl} />
              <Trash2 size={12} />
            </button>
          ))}
        </div>
      ) : null}

      <form className="quick-chat-form" onSubmit={sendMessage}>
        <textarea
          value={draft}
            placeholder="发消息，或附图让 gpt-5.5 分析..."
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void sendMessage();
            }
          }}
        />
        <div className="quick-chat-toolbar">
          <input ref={fileInputRef} accept="image/*" multiple type="file" onChange={handleFiles} />
          <button type="button" onClick={() => fileInputRef.current?.click()} title="添加图片">
            <Paperclip size={16} />
          </button>
          <button className="quick-chat-send" type="submit" disabled={!canSend || busy} title="发送">
            {busy ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
          </button>
        </div>
      </form>

      <div className="quick-chat-actions">
        <button type="button" disabled={Boolean(nodeBusy)} onClick={() => void createCanvasNode('text')}>
          <PenLine size={15} />
          <span>文本节点</span>
        </button>
        <button type="button" disabled={Boolean(nodeBusy)} onClick={() => void createCanvasNode('image')}>
          <Image size={15} />
          <span>图像节点</span>
        </button>
        <button type="button" disabled={Boolean(nodeBusy)} onClick={() => void createCanvasNode('video')}>
          <Video size={15} />
          <span>视频节点</span>
        </button>
        <button type="button" disabled={Boolean(nodeBusy)} onClick={() => void createCanvasNode('asset')}>
          {nodeBusy === 'asset' ? <Loader2 className="spin" size={15} /> : <FileStack size={15} />}
          <span>素材节点</span>
        </button>
      </div>

      <div className="quick-panel-note">
        {nodeBusy ? <Loader2 className="spin" size={15} /> : <KeyRound size={15} />}
        {notice || '聊天走 Sub2API；节点生成继续走当前画布队列。'}
      </div>
      <div className="quick-chat-run-hint">
        <Play size={13} />
        文本/图像/视频按钮会直接创建节点并运行。
      </div>
    </section>
  );
}
