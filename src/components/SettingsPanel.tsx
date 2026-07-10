import {
  AlignLeft,
  Bell,
  CheckCircle2,
  CircleAlert,
  FolderOpen,
  Grid2X2,
  Keyboard,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  SearchCheck,
  ShieldCheck,
  SquarePlus,
  Volume2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { previewCompletionTone } from '../services/completionNotifier';
import { useSettingsStore, type ApiProviderId, type ProviderDrafts, type StudioSettings } from '../store/settingsStore';

type SettingsSection = 'general' | 'canvas' | 'nodes' | 'files' | 'api' | 'subscription' | 'shortcuts';

interface SettingNavItem {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
}

const sections: SettingNavItem[] = [
  { id: 'general', label: '常规', icon: Grid2X2 },
  { id: 'canvas', label: '画布与对齐', icon: AlignLeft },
  { id: 'nodes', label: '节点创建与行为', icon: SquarePlus },
  { id: 'files', label: '文件与保存', icon: FolderOpen },
  { id: 'api', label: 'API Key', icon: KeyRound },
  { id: 'subscription', label: '订阅中心', icon: ShieldCheck },
  { id: 'shortcuts', label: '键盘快捷键', icon: Keyboard },
];

const colorSwatches = ['#ffffff', '#2f86ff', '#19c58f', '#12b8d4', '#8758ff', '#f24a4f', '#ffcb2f'];

const shortcutGroups: Array<{ title: string; items: Array<[string, string[]]> }> = [
  {
    title: '通用',
    items: [
      ['放大', ['Mod', '+']],
      ['缩小', ['Mod', '-']],
      ['聚焦节点/适应画布', ['F']],
      ['小地图', ['M']],
      ['网格吸附', ['L']],
      ['拖动画布（按住）', ['Space']],
      ['保存画布', ['Mod', 'S']],
      ['打开设置', ['K']],
    ],
  },
  {
    title: '编辑与选择',
    items: [
      ['删除节点', ['D']],
      ['删除节点/连线', ['Backspace']],
      ['长按显示对齐工具', ['A']],
    ],
  },
];

const apiProviders = [
  {
    id: 'anycap',
    label: 'AnyCap',
    badge: 'AC',
    description: '本地 AnyCap CLI / 网关，用于视频、音频和媒体任务。',
    endpointLabel: 'CLI 或网关地址',
    endpointPlaceholder: '例如 anycap 或 http://127.0.0.1:8778',
  },
  {
    id: 'sub2api',
    label: 'Sub2API',
    badge: 'OA',
    description: 'OpenAI-compatible 聚合服务，默认承接文本和图片。',
    endpointLabel: 'Base URL',
    endpointPlaceholder: '例如 http://10.0.0.239:3000',
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI Compatible',
    badge: 'OC',
    description: '自定义 OpenAI 兼容接口，可作为文本/图片备用 provider。',
    endpointLabel: 'Base URL',
    endpointPlaceholder: '例如 https://api.openai.com',
  },
  {
    id: 'runninghub',
    label: 'RunningHUB',
    badge: 'RH',
    description: 'RunningHUB 工作流入口，后续用于工作流类节点。',
    endpointLabel: 'Base URL',
    endpointPlaceholder: '例如 https://www.runninghub.cn',
  },
] as const;

type ProviderCheckPhase = 'idle' | 'checking' | 'success' | 'error' | 'login';

interface ProviderModelInfo {
  id: string;
  label?: string;
  description?: string;
}

interface ProviderCapabilityInfo {
  id: string;
  label: string;
  available: boolean;
  modelCount?: number;
  message?: string;
  models?: ProviderModelInfo[];
}

interface AnyCapLoginInfo {
  sessionId: string;
  verificationUri: string;
  userCode: string;
  authenticated?: boolean;
  pollCommand?: string;
  nextActionHint?: string;
}

interface ProviderCheckState {
  phase: ProviderCheckPhase;
  message: string;
  models?: ProviderModelInfo[];
  capabilities?: ProviderCapabilityInfo[];
  login?: AnyCapLoginInfo;
}

type ProviderStatusMap = Record<ApiProviderId, ProviderCheckState>;

const initialProviderStatus: ProviderStatusMap = {
  anycap: { phase: 'idle', message: '' },
  sub2api: { phase: 'idle', message: '' },
  'openai-compatible': { phase: 'idle', message: '' },
  runninghub: { phase: 'idle', message: '' },
};

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload.error || payload.message || `HTTP ${response.status}`));
  }
  return payload as T;
}

function SettingRow({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function Segment<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T; icon?: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="settings-segment">
      {options.map((option) => (
        <button
          className={option.value === value ? 'is-active' : ''}
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

function TogglePair({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="settings-segment settings-toggle-pair">
      <button className={value ? 'is-active' : ''} type="button" onClick={() => onChange(true)}>
        开
      </button>
      <button className={!value ? 'is-active' : ''} type="button" onClick={() => onChange(false)}>
        关
      </button>
    </div>
  );
}

function RangeControl({
  max,
  min,
  suffix,
  value,
  onChange,
}: {
  max: number;
  min: number;
  suffix?: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="settings-range">
      <input max={max} min={min} type="range" value={value} onChange={(event) => onChange(Number(event.currentTarget.value))} />
      <span>{value}{suffix}</span>
    </div>
  );
}

function ColorSwatches({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="settings-color-row">
      {colorSwatches.map((color) => (
        <button
          aria-label={`高亮颜色 ${color}`}
          className={value === color ? 'is-active' : ''}
          key={color}
          style={{ background: color }}
          type="button"
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  );
}

function ShortcutKeys({ keys, modifier }: { keys: string[]; modifier: string }) {
  return (
    <span className="shortcut-keys">
      {keys.map((key) => (
        <kbd key={key}>{key === 'Mod' ? modifier : key}</kbd>
      ))}
    </span>
  );
}

function GeneralSettings({
  settings,
  setSetting,
}: {
  settings: StudioSettings;
  setSetting: <Key extends keyof StudioSettings>(key: Key, value: StudioSettings[Key]) => void;
}) {
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );

  const updateCornerNotification = async (enabled: boolean) => {
    if (!enabled) {
      setSetting('cornerNotification', false);
      return;
    }
    if (typeof Notification === 'undefined') {
      setNotificationPermission('unsupported');
      setSetting('cornerNotification', false);
      return;
    }
    const permission = Notification.permission === 'default'
      ? await Notification.requestPermission()
      : Notification.permission;
    setNotificationPermission(permission);
    setSetting('cornerNotification', permission === 'granted');
  };

  return (
    <>
      <div className="settings-group">
        <h3>界面外观</h3>
        <SettingRow title="语言" description="当前版本提供完整的简体中文界面；英文界面正在适配">
          <select value={settings.language} onChange={(event) => setSetting('language', event.currentTarget.value as StudioSettings['language'])}>
            <option value="zh-CN">简体中文</option>
            <option value="en-US" disabled>English（即将支持）</option>
          </select>
        </SettingRow>
        <SettingRow title="应用主题" description="切换界面整体明暗外观">
          <Segment
            value={settings.theme}
            onChange={(value) => setSetting('theme', value)}
            options={[
              { label: '暗夕', value: 'dusk' },
              { label: '晨雾', value: 'mist' },
              { label: '白昼', value: 'day' },
            ]}
          />
        </SettingRow>
        <SettingRow title="提示词与动作栏质感" description="控制节点底部输入栏和浮动动作栏的背景样式">
          <Segment
            value={settings.inputSurface}
            onChange={(value) => setSetting('inputSurface', value)}
            options={[
              { label: '透明', value: 'transparent' },
              { label: '毛玻璃', value: 'frosted' },
            ]}
          />
        </SettingRow>
      </div>
      <div className="settings-group">
        <h3>输入偏好</h3>
        <SettingRow title="鼠标大小" description="选择光标显示大小">
          <Segment
            value={settings.cursorSize}
            onChange={(value) => setSetting('cursorSize', value)}
            options={[
              { label: '小', value: 'small' },
              { label: '中', value: 'medium' },
              { label: '大', value: 'large' },
            ]}
          />
        </SettingRow>
        <SettingRow title="输入字体大小" description="调整节点提示词输入框的字体大小">
          <Segment
            value={settings.inputFontSize}
            onChange={(value) => setSetting('inputFontSize', value)}
            options={[
              { label: '小', value: 'small' },
              { label: '中', value: 'medium' },
              { label: '大', value: 'large' },
            ]}
          />
        </SettingRow>
        <SettingRow title="提示词回车行为" description="切到 Enter 换行后，可用 Ctrl/⌘+Enter 发送">
          <Segment
            value={settings.enterBehavior}
            onChange={(value) => setSetting('enterBehavior', value)}
            options={[
              { label: 'Enter 发送', value: 'send' },
              { label: 'Enter 换行', value: 'newline' },
            ]}
          />
        </SettingRow>
        <SettingRow title="图片入参上传质量" description="生成前参考图上传的压缩档位">
          <Segment
            value={settings.imageReferenceQuality}
            onChange={(value) => setSetting('imageReferenceQuality', value)}
            options={[
              { label: '标准', value: 'standard' },
              { label: '高保真', value: 'high' },
              { label: '原图优先', value: 'original' },
            ]}
          />
        </SettingRow>
      </div>
      <div className="settings-group">
        <h3>完成通知</h3>
        <SettingRow title="生成完成提示音" description="生成任务成功后播放提示音">
          <TogglePair value={settings.completionSound} onChange={(value) => setSetting('completionSound', value)} />
        </SettingRow>
        <SettingRow title="右下角通知" description="画布窗口未激活时，生成成功后显示系统通知">
          <div className="settings-inline-control">
            <TogglePair value={settings.cornerNotification} onChange={(value) => void updateCornerNotification(value)} />
            <small>
              {notificationPermission === 'granted'
                ? '已授权'
                : notificationPermission === 'denied'
                  ? '浏览器已拒绝'
                  : notificationPermission === 'unsupported'
                    ? '当前浏览器不支持'
                    : '开启时请求授权'}
            </small>
          </div>
        </SettingRow>
        <SettingRow title="提示音音量" description="控制完成提示音播放大小">
          <div className="settings-inline-control settings-volume-control">
            <RangeControl min={0} max={100} value={settings.promptVolume} suffix="%" onChange={(value) => setSetting('promptVolume', value)} />
            <button className="settings-icon-action" type="button" onClick={previewCompletionTone} title="试听提示音" aria-label="试听提示音">
              <Volume2 size={17} />
            </button>
          </div>
        </SettingRow>
      </div>
    </>
  );
}

function CanvasSettings({
  settings,
  setSetting,
}: {
  settings: StudioSettings;
  setSetting: <Key extends keyof StudioSettings>(key: Key, value: StudioSettings[Key]) => void;
}) {
  return (
    <>
      <div className="settings-group">
        <h3>画布显示</h3>
        <SettingRow title="网格点显示" description="只影响显示，不影响网格吸附">
          <TogglePair value={settings.gridVisible} onChange={(value) => setSetting('gridVisible', value)} />
        </SettingRow>
        <SettingRow title="连接线显示" description="只控制画布上的连接线可见性，不影响节点连接关系">
          <TogglePair value={settings.connectionVisible} onChange={(value) => setSetting('connectionVisible', value)} />
        </SettingRow>
        <SettingRow title="点击节点时高亮关联节点" description="选中节点后高亮直接连接的上下游节点和连线">
          <TogglePair value={settings.highlightConnections} onChange={(value) => setSetting('highlightConnections', value)} />
        </SettingRow>
        <SettingRow title="高亮颜色" description="设置关联节点边框与光晕颜色">
          <ColorSwatches value={settings.highlightColor} onChange={(value) => setSetting('highlightColor', value)} />
        </SettingRow>
      </div>
      <div className="settings-group">
        <h3>拖拽吸附</h3>
        <SettingRow title="辅助线吸附" description="开启后单节点拖拽时显示辅助线并自动吸附">
          <TogglePair value={settings.guideSnap} onChange={(value) => setSetting('guideSnap', value)} />
        </SettingRow>
        <SettingRow title="网格吸附" description="开启后拖拽节点时按网格吸附对齐">
          <TogglePair value={settings.gridSnap} onChange={(value) => setSetting('gridSnap', value)} />
        </SettingRow>
      </div>
      <div className="settings-group">
        <h3>多选对齐</h3>
        <SettingRow title="启动多选对齐功能" description="可设置为长按或点击快捷键触发中心对齐面板">
          <Segment
            value={settings.multiAlignMode}
            onChange={(value) => setSetting('multiAlignMode', value)}
            options={[
              { label: '长按开启', value: 'hold' },
              { label: '点击开启', value: 'click' },
              { label: '关闭', value: 'off' },
            ]}
          />
        </SettingRow>
        <SettingRow title="对齐间距" description="分布时固定首节点，后续节点按该间距顺排">
          <RangeControl min={16} max={120} value={settings.alignSpacing} onChange={(value) => setSetting('alignSpacing', value)} />
        </SettingRow>
      </div>
    </>
  );
}

function NodeSettings({
  settings,
  setSetting,
}: {
  settings: StudioSettings;
  setSetting: <Key extends keyof StudioSettings>(key: Key, value: StudioSettings[Key]) => void;
}) {
  return (
    <>
      <div className="settings-group">
        <h3>节点显示</h3>
        <SettingRow title="视频节点信息" description="显示视频节点下方的分辨率/帧数/帧率">
          <TogglePair value={settings.videoNodeInfo} onChange={(value) => setSetting('videoNodeInfo', value)} />
        </SettingRow>
        <SettingRow title="标题跟随画布缩放" description="开启后普通节点标题会随画布缩放；关闭后保持屏幕大小不变">
          <TogglePair value={settings.titleScaleWithCanvas} onChange={(value) => setSetting('titleScaleWithCanvas', value)} />
        </SettingRow>
      </div>
      <div className="settings-group">
        <h3>节点交互</h3>
        <SettingRow title="图像视频节点缩放" description="开启后可在图像/视频节点右下角拖拽缩放">
          <TogglePair value={settings.mediaNodeResize} onChange={(value) => setSetting('mediaNodeResize', value)} />
        </SettingRow>
        <SettingRow title="允许提示词栏下拉" description="开启后可在提示词栏底边拖拽上下调整高度">
          <TogglePair value={settings.composerResizable} onChange={(value) => setSetting('composerResizable', value)} />
        </SettingRow>
      </div>
      <div className="settings-group">
        <h3>新节点生成</h3>
        <SettingRow title="创建节点间距" description="新节点生成时的水平偏移距离">
          <RangeControl min={40} max={240} value={settings.newNodeSpacing} onChange={(value) => setSetting('newNodeSpacing', value)} />
        </SettingRow>
        <SettingRow title="新节点连续生成方向" description="遇到空间重叠占用时向哪找出路">
          <Segment
            value={settings.newNodeDirection}
            onChange={(value) => setSetting('newNodeDirection', value)}
            options={[
              { label: '向右', value: 'right' },
              { label: '向下', value: 'down' },
            ]}
          />
        </SettingRow>
        <SettingRow title="新节点自动避让" description="新节点生成时自动避让已有节点">
          <TogglePair value={settings.newNodeAvoidOverlap} onChange={(value) => setSetting('newNodeAvoidOverlap', value)} />
        </SettingRow>
      </div>
    </>
  );
}

function FilesSettings({
  settings,
  setSetting,
}: {
  settings: StudioSettings;
  setSetting: <Key extends keyof StudioSettings>(key: Key, value: StudioSettings[Key]) => void;
}) {
  const [phase, setPhase] = useState<'idle' | 'working' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let mounted = true;
    void fetch('/api/settings/storage')
      .then(async (response) => {
        const payload = await response.json() as { saveRoot?: string; outputDir?: string; error?: string };
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        if (!mounted) return;
        if (payload.saveRoot) setSetting('saveRoot', payload.saveRoot);
        setMessage(payload.outputDir ? `当前输出目录：${payload.outputDir}` : '使用项目默认输出目录。');
      })
      .catch((error) => {
        if (!mounted) return;
        setPhase('error');
        setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      mounted = false;
    };
  }, [setSetting]);

  const applyRoot = async (saveRoot: string) => {
    setPhase('working');
    setMessage('正在验证并切换保存目录...');
    try {
      const payload = await postJson<{ saveRoot: string; outputDir: string }>('/api/settings/storage', { saveRoot });
      setSetting('saveRoot', payload.saveRoot);
      setPhase('success');
      setMessage(`已切换：${payload.outputDir}`);
    } catch (error) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const chooseRoot = async () => {
    setPhase('working');
    setMessage('请在系统窗口中选择目录...');
    try {
      const payload = await postJson<{ saveRoot: string; outputDir: string }>('/api/settings/storage/select', {});
      setSetting('saveRoot', payload.saveRoot);
      setPhase('success');
      setMessage(`已切换：${payload.outputDir}`);
    } catch (error) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="settings-group">
      <p className="settings-muted">
        配置生成输出和上传素材的本地保存目录。画布项目与用户设置继续保存在浏览器本地存储中。
      </p>
      <div className="settings-file-box">
        <div>
          <strong>保存根目录</strong>
          <span>媒体文件会保存在所选目录下的 output 文件夹</span>
        </div>
        <input
          value={settings.saveRoot}
          placeholder="例如 D:\\AI CanvasPro Files"
          onChange={(event) => setSetting('saveRoot', event.currentTarget.value)}
        />
        <div className="settings-file-actions">
          <button type="button" disabled={phase === 'working'} onClick={() => void applyRoot(settings.saveRoot)}>
            {phase === 'working' ? <Loader2 className="spin" size={18} /> : <CheckCircle2 size={18} />}
            <span>应用</span>
          </button>
          <button type="button" disabled={phase === 'working'} onClick={() => void chooseRoot()}>
            <FolderOpen size={18} />
            <span>选择</span>
          </button>
        </div>
      </div>
      {message && <div className={`settings-storage-message is-${phase}`} role="status">{message}</div>}
    </div>
  );
}

function ApiSettings() {
  const draft = useSettingsStore((state) => state.providerDrafts);
  const setProviderDraft = useSettingsStore((state) => state.setProviderDraft);
  const [providerStatus, setProviderStatus] = useState<ProviderStatusMap>(initialProviderStatus);

  const updateDraft = (providerId: ApiProviderId, key: keyof ProviderDrafts[ApiProviderId], value: string) => {
    setProviderDraft(providerId, { [key]: value } as Partial<ProviderDrafts[ApiProviderId]>);
  };

  const setProviderState = (providerId: ApiProviderId, patch: Partial<ProviderCheckState>) => {
    setProviderStatus((current) => ({
      ...current,
      [providerId]: { ...current[providerId], ...patch },
    }));
  };

  const providerPayload = (providerId: ApiProviderId) => ({
    provider: providerId,
    endpoint: draft[providerId].endpoint,
    apiKey: draft[providerId].apiKey,
  });

  const checkProvider = async (providerId: ApiProviderId) => {
    setProviderState(providerId, { phase: 'checking', message: '正在检测 provider...', login: undefined });
    try {
      const payload = await postJson<{
        available?: boolean;
        authenticated?: boolean;
        message?: string;
        models?: ProviderModelInfo[];
        modelCount?: number;
      }>('/api/providers/check', providerPayload(providerId));
      const countText = payload.modelCount ? ` · ${payload.modelCount} 个模型` : '';
      const authText = providerId === 'anycap' && payload.available ? (payload.authenticated ? ' · 已登录' : ' · 未确认登录') : '';
      setProviderState(providerId, {
        phase: payload.available ? 'success' : 'error',
        message: `${payload.message || (payload.available ? '检测通过' : '检测失败')}${authText}${countText}`,
        models: payload.models,
      });
    } catch (error) {
      setProviderState(providerId, { phase: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const startAnyCapLogin = async () => {
    setProviderState('anycap', { phase: 'checking', message: '正在启动 AnyCap 登录...', login: undefined });
    try {
      const payload = await postJson<AnyCapLoginInfo>('/api/providers/anycap/login/start', providerPayload('anycap'));
      if (payload.authenticated) {
        setProviderState('anycap', {
          phase: 'success',
          message: payload.nextActionHint || 'AnyCap 已登录；切换账号请先退出登录。',
          login: undefined,
        });
        return;
      }
      setProviderState('anycap', {
        phase: 'login',
        message: payload.nextActionHint || '请打开验证链接完成 AnyCap 登录。',
        login: payload,
      });
    } catch (error) {
      setProviderState('anycap', { phase: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const logoutAnyCap = async () => {
    setProviderState('anycap', { phase: 'checking', message: '正在退出 AnyCap 登录...', login: undefined });
    try {
      const payload = await postJson<{ available?: boolean; message?: string }>('/api/providers/anycap/logout', providerPayload('anycap'));
      setProviderState('anycap', {
        phase: payload.available ? 'idle' : 'error',
        message: payload.message || (payload.available ? 'AnyCap 已退出登录；现在可以重新登录获取 code。' : 'AnyCap 退出登录失败。'),
        login: undefined,
      });
    } catch (error) {
      setProviderState('anycap', { phase: 'error', message: error instanceof Error ? error.message : String(error), login: undefined });
    }
  };

  const pollAnyCapLogin = async () => {
    const login = providerStatus.anycap.login;
    if (!login?.sessionId) {
      setProviderState('anycap', { phase: 'error', message: '缺少登录 session，请重新点击登录。' });
      return;
    }
    setProviderState('anycap', { phase: 'checking', message: '正在检查 AnyCap 登录状态...' });
    try {
      const payload = await postJson<{ available?: boolean; authenticated?: boolean; message?: string }>('/api/providers/anycap/login/poll', {
        ...providerPayload('anycap'),
        sessionId: login.sessionId,
      });
      setProviderState('anycap', {
        phase: payload.available ? 'success' : 'error',
        message: payload.authenticated ? 'AnyCap 已登录。' : payload.message || 'AnyCap 状态已刷新。',
        login: undefined,
      });
    } catch (error) {
      setProviderState('anycap', {
        phase: 'login',
        message: error instanceof Error ? error.message : String(error),
        login,
      });
    }
  };

  const scanAnyCapCapabilities = async () => {
    setProviderState('anycap', { phase: 'checking', message: '正在扫描 AnyCap 能力和模型...', login: undefined });
    try {
      const payload = await postJson<{
        available?: boolean;
        message?: string;
        capabilities?: ProviderCapabilityInfo[];
      }>('/api/providers/anycap/capabilities', providerPayload('anycap'));
      setProviderState('anycap', {
        phase: payload.available ? 'success' : 'error',
        message: payload.message || 'AnyCap 能力扫描完成。',
        capabilities: payload.capabilities,
      });
    } catch (error) {
      setProviderState('anycap', { phase: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const statusLabel = (phase: ProviderCheckPhase) => {
    if (phase === 'checking') return '检测中';
    if (phase === 'success') return '可用';
    if (phase === 'error') return '异常';
    if (phase === 'login') return '待登录';
    return '未检测';
  };

  const statusIcon = (phase: ProviderCheckPhase) => {
    if (phase === 'checking') return <Loader2 size={15} />;
    if (phase === 'success') return <CheckCircle2 size={15} />;
    if (phase === 'error') return <CircleAlert size={15} />;
    if (phase === 'login') return <LogIn size={15} />;
    return <SearchCheck size={15} />;
  };

  return (
    <div className="settings-group settings-api-group">
      <p className="settings-muted">这里不会保存真实 key；检测时只把当前输入临时发送给本地 server.py，用于连通性和模型能力探测。</p>
      {apiProviders.map((provider) => {
        const state = providerStatus[provider.id];
        const isChecking = state.phase === 'checking';
        return (
          <article className="api-provider-card" key={provider.id}>
            <div className="api-provider-head">
              <span>{provider.badge}</span>
              <div>
                <strong>{provider.label}</strong>
                <small>{provider.description}</small>
              </div>
              <em className={`api-status-pill is-${state.phase}`}>
                {statusIcon(state.phase)}
                {statusLabel(state.phase)}
              </em>
            </div>
            <label>
              <span>{provider.endpointLabel}</span>
              <input
                value={draft[provider.id].endpoint}
                placeholder={provider.endpointPlaceholder}
                onChange={(event) => updateDraft(provider.id, 'endpoint', event.currentTarget.value)}
              />
            </label>
            <label>
              <span>API Key</span>
              <input
                type="password"
                value={draft[provider.id].apiKey}
                placeholder="仅临时检测使用，不会保存"
                onChange={(event) => updateDraft(provider.id, 'apiKey', event.currentTarget.value)}
              />
            </label>
            <div className="api-provider-actions">
              <button type="button" disabled={isChecking} onClick={() => checkProvider(provider.id)}>
                <SearchCheck size={16} />
                <span>检测</span>
              </button>
              {provider.id === 'anycap' && (
                <>
                  <button type="button" disabled={isChecking} onClick={startAnyCapLogin}>
                    <LogIn size={16} />
                    <span>登录</span>
                  </button>
                  <button type="button" disabled={isChecking} onClick={logoutAnyCap}>
                    <LogOut size={16} />
                    <span>退出登录</span>
                  </button>
                  <button type="button" disabled={isChecking} onClick={scanAnyCapCapabilities}>
                    <RefreshCw size={16} />
                    <span>能力/模型</span>
                  </button>
                </>
              )}
            </div>
            {state.message && <div className={`api-provider-message is-${state.phase}`}>{state.message}</div>}
            {provider.id === 'anycap' && state.login && (
              <div className="api-login-box">
                <div>
                  <strong>AnyCap 设备登录</strong>
                  <span>{state.login.nextActionHint || '打开链接完成登录，再点击检查登录。'}</span>
                </div>
                {state.login.verificationUri && (
                  <a href={state.login.verificationUri} target="_blank" rel="noreferrer">
                    打开登录页
                  </a>
                )}
                {state.login.userCode && <code>{state.login.userCode}</code>}
                <button type="button" onClick={pollAnyCapLogin}>
                  我已完成，检查登录
                </button>
              </div>
            )}
            {(state.capabilities?.length || state.models?.length) && (
              <div className="api-capability-list">
                {state.capabilities?.map((capability) => (
                  <div className={`api-capability-chip ${capability.available ? 'is-ok' : 'is-error'}`} key={capability.id}>
                    <strong>{capability.label}</strong>
                    <span>{capability.available ? `${capability.modelCount || 0} 个模型` : capability.message || '不可用'}</span>
                    {capability.models?.length ? (
                      <small>{capability.models.slice(0, 5).map((model) => model.label || model.id).join(' / ')}</small>
                    ) : null}
                  </div>
                ))}
                {!state.capabilities?.length && state.models?.length ? (
                  <div className="api-capability-chip is-ok">
                    <strong>模型</strong>
                    <span>{state.models.length} 个模型</span>
                    <small>{state.models.slice(0, 6).map((model) => model.label || model.id).join(' / ')}</small>
                  </div>
                ) : null}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function SubscriptionSettings() {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [summary, setSummary] = useState({ queueAvailable: false, jobs: 0, outputDir: '' });
  const [message, setMessage] = useState('');

  const refresh = async () => {
    setPhase('loading');
    try {
      const [healthResponse, jobsResponse] = await Promise.all([
        fetch('/api/health'),
        fetch('/api/generation/jobs'),
      ]);
      const health = await healthResponse.json() as {
        queue?: { available?: boolean; reason?: string };
        outputDir?: string;
        error?: string;
      };
      const jobs = await jobsResponse.json() as unknown;
      if (!healthResponse.ok) throw new Error(health.error || `HTTP ${healthResponse.status}`);
      setSummary({
        queueAvailable: Boolean(health.queue?.available),
        jobs: Array.isArray(jobs) ? jobs.length : 0,
        outputDir: String(health.outputDir || ''),
      });
      setMessage(health.queue?.available ? '本地任务服务运行正常。' : health.queue?.reason || '任务服务当前不可用。');
      setPhase('ready');
    } catch (error) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="settings-subscription">
      <div className="subscription-overview">
        <span className="subscription-badge">LOCAL</span>
        <div>
          <strong>SelfCanvas 本地工作区</strong>
          <small>当前不绑定平台套餐；模型费用与配额由已连接的 Provider 决定。</small>
        </div>
        <button type="button" disabled={phase === 'loading'} onClick={() => void refresh()}>
          <RefreshCw className={phase === 'loading' ? 'spin' : ''} size={17} />
          刷新
        </button>
      </div>
      <div className="subscription-metrics">
        <article>
          <span>任务服务</span>
          <strong>{summary.queueAvailable ? '可用' : '不可用'}</strong>
        </article>
        <article>
          <span>任务记录</span>
          <strong>{summary.jobs}</strong>
        </article>
        <article>
          <span>计费方式</span>
          <strong>Provider 侧</strong>
        </article>
      </div>
      <div className={`subscription-status is-${phase}`} role="status">
        <Bell size={16} />
        <span>{message || '正在读取服务状态...'}</span>
      </div>
      {summary.outputDir && <p className="settings-muted">当前输出目录：{summary.outputDir}</p>}
    </div>
  );
}

function ShortcutSettings({
  settings,
  setSetting,
}: {
  settings: StudioSettings;
  setSetting: <Key extends keyof StudioSettings>(key: Key, value: StudioSettings[Key]) => void;
}) {
  const nativeModifier = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const modifier = settings.shortcutPreset === 'native' ? nativeModifier : 'Ctrl';
  return (
    <div className="settings-shortcuts">
      <label className="settings-preset-select">
        <span>预设方案</span>
        <select
          value={settings.shortcutPreset}
          onChange={(event) => setSetting('shortcutPreset', event.currentTarget.value as StudioSettings['shortcutPreset'])}
        >
          <option value="native">系统原生</option>
          <option value="canvaspro">CanvasPro 风格</option>
        </select>
      </label>
      <p className="settings-muted">列表只展示当前已经生效的快捷键，输入框聚焦时不会触发画布命令。</p>
      {shortcutGroups.map((group) => (
        <section className="shortcut-group" key={group.title}>
          <h3>{group.title}</h3>
          <div className="shortcut-list">
            {group.items.map(([label, keys]) => (
              <div className="shortcut-item" key={label}>
                <span>{label}</span>
                <ShortcutKeys keys={keys as string[]} modifier={modifier} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');
  const [resetNotice, setResetNotice] = useState('');
  const settings = useSettingsStore((state) => state.settings);
  const setSetting = useSettingsStore((state) => state.setSetting);
  const resetSettings = useSettingsStore((state) => state.resetSettings);
  const section = sections.find((item) => item.id === activeSection) ?? sections[0];
  const SectionIcon = section.icon;

  const body = (() => {
    if (activeSection === 'canvas') return <CanvasSettings settings={settings} setSetting={setSetting} />;
    if (activeSection === 'nodes') return <NodeSettings settings={settings} setSetting={setSetting} />;
    if (activeSection === 'files') return <FilesSettings settings={settings} setSetting={setSetting} />;
    if (activeSection === 'api') return <ApiSettings />;
    if (activeSection === 'subscription') return <SubscriptionSettings />;
    if (activeSection === 'shortcuts') return <ShortcutSettings settings={settings} setSetting={setSetting} />;
    return <GeneralSettings settings={settings} setSetting={setSetting} />;
  })();

  return (
    <section className="settings-modal floating-panel" role="dialog" aria-modal="true" aria-label="设置">
      <aside className="settings-sidebar">
        <h2>设置</h2>
        <nav>
          {sections.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={activeSection === item.id ? 'is-active' : ''}
                key={item.id}
                type="button"
                onClick={() => setActiveSection(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>
      <div className="settings-main">
        <header className="settings-main-header">
          <div>
            <SectionIcon size={20} />
            <h2>{section.label}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭设置">
            <X size={22} />
          </button>
        </header>
        <div className="settings-scroll">{body}</div>
        <footer className="settings-footer">
          <span aria-live="polite">{resetNotice || '设置会自动保存到 localStorage: selfcanvas.settings.v1'}</span>
          <button
            type="button"
            onClick={() => {
              resetSettings();
              setResetNotice('已恢复默认设置');
              window.setTimeout(() => setResetNotice(''), 2400);
            }}
          >
            恢复默认设置
          </button>
        </footer>
      </div>
    </section>
  );
}
