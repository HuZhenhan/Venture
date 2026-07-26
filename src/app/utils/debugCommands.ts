export type DebugModule = 'OriginalContent' | 'RawResponse' | 'OccupancyMonitor' | 'Sidebar' | 'ClickLog' | 'TestButton' | 'Layout';

export interface DebugCommand {
  module: DebugModule;
  enabled: boolean;
}

const DEBUG_MODULES: Record<string, DebugModule> = {
  originalcontent: 'OriginalContent',
  rawresponse: 'RawResponse',
  occupancymonitor: 'OccupancyMonitor',
  sidebar: 'Sidebar',
  clicklog: 'ClickLog',
  testbutton: 'TestButton',
  layout: 'Layout',
};

const BOOLEAN_VALUES: Record<string, boolean> = {
  true: true,
  ture: true,
  false: false,
  flase: false,
};

export function parseDebugCommand(input: string): DebugCommand | null {
  const parts = input.trim().split(/\s+/);
  if (parts.length !== 3 || parts[0].toLowerCase() !== '/debug') {
    return null;
  }

  const module = DEBUG_MODULES[parts[1].toLowerCase()];
  const enabled = BOOLEAN_VALUES[parts[2].toLowerCase()];

  if (!module || typeof enabled !== 'boolean') {
    return null;
  }

  return { module, enabled };
}
