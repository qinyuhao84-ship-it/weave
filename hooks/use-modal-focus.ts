"use client";
import * as React from "react";

/** 抽屉与弹窗共享焦点约束；inert 同时阻止背景点击、Tab 与读屏操作。 */
export function useModalFocus(open: boolean, panelRef: React.RefObject<HTMLElement | null>, onClose: () => void) {
  const close = React.useRef(onClose);
  React.useLayoutEffect(() => { close.current = onClose; }, [onClose]);
  React.useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const previous = document.activeElement as HTMLElement | null;
    const background = new Map<HTMLElement, boolean>();
    let branch: HTMLElement = panel;
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling instanceof HTMLElement && sibling !== branch && !sibling.hasAttribute("data-modal-dismiss")) {
          background.set(sibling, sibling.inert);
          // 操作真实 DOM 的可访问性状态，不修改 React props；关闭时恢复原值。
          // eslint-disable-next-line react-hooks/immutability
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
      if (branch === document.body) break;
    }
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () => [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(node => node.getClientRects().length && !node.closest('[inert]'));
    (focusable()[0] ?? panel).focus();
    // 阶段切换会移除原聚焦按钮；把失去的焦点重新放回仍打开的弹窗。
    const observer = new MutationObserver(() => {
      if (!panel.closest("[inert]") && document.activeElement === document.body) (focusable()[0] ?? panel).focus();
    });
    observer.observe(panel, { childList: true, subtree: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || panel.inert) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== "Tab") return;
      const items = focusable();
      event.preventDefault();
      if (!items.length) { panel.focus(); return; }
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next = index < 0 ? (event.shiftKey ? items.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + items.length) % items.length;
      items[next].focus();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", onKey);
      for (const [node, inert] of background) node.inert = inert;
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [open, panelRef]);
}
