import type { DesktopTask, DesktopTaskCapability, DesktopTaskProvider } from '../types';

class WebDesktopTaskProvider implements DesktopTaskProvider {
  async getCapability(): Promise<DesktopTaskCapability> {
    return {
      available: false,
      reason: '当前 Web 环境无法访问桌面后台任务',
    };
  }

  async listTasks(): Promise<DesktopTask[]> {
    return [];
  }
}

export const desktopTaskProvider: DesktopTaskProvider = new WebDesktopTaskProvider();
