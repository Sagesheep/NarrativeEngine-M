export type NotifyFn = (message: string) => void;
export interface NotifyImpl {
  success: NotifyFn;
  error: NotifyFn;
  warning: NotifyFn;
  info: NotifyFn;
}

let impl: NotifyImpl = {
  success: (m) => console.info('[notify:success]', m),
  error:   (m) => console.error('[notify:error]', m),
  warning: (m) => console.warn('[notify:warning]', m),
  info:    (m) => console.info('[notify:info]', m),
};

export function setNotifyImpl(next: NotifyImpl): void {
  impl = next;
}

export const notify: NotifyImpl = {
  success: (m) => impl.success(m),
  error:   (m) => impl.error(m),
  warning: (m) => impl.warning(m),
  info:    (m) => impl.info(m),
};