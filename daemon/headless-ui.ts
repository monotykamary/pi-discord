export interface HeadlessUi {
  select: () => Promise<undefined>;
  confirm: () => Promise<false>;
  input: () => Promise<undefined>;
  notify: () => undefined;
  onTerminalInput: () => () => undefined;
  setStatus: () => undefined;
  setWorkingMessage: () => undefined;
  setWidget: () => undefined;
  setFooter: () => undefined;
  setHeader: () => undefined;
  setTitle: () => undefined;
  custom: () => Promise<undefined>;
  pasteToEditor: () => undefined;
  setEditorText: () => undefined;
  getEditorText: () => "";
  editor: () => Promise<undefined>;
  setEditorComponent: () => undefined;
}

export function createHeadlessUi(): HeadlessUi {
  const noop = () => undefined;
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: () => undefined,
    onTerminalInput: () => noop,
    setStatus: () => undefined,
    setWorkingMessage: () => undefined,
    setWidget: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle: () => undefined,
    custom: async () => undefined,
    pasteToEditor: () => undefined,
    setEditorText: () => undefined,
    getEditorText: () => "",
    editor: async () => undefined,
    setEditorComponent: () => undefined,
  };
}
