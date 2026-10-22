import { useEffect, useRef, useState } from 'react';

// In-app replacement for window.confirm (not reliably available in desktop webviews).

type Request = { message: string; confirmLabel: string; danger: boolean; resolve: (ok: boolean) => void };

let show: ((r: Request) => void) | null = null;

export function confirmDialog(message: string, opts: { confirmLabel?: string; danger?: boolean } = {}): Promise<boolean> {
    return new Promise(resolve => {
        if (!show) return resolve(window.confirm(message));
        show({ message, confirmLabel: opts.confirmLabel ?? 'OK', danger: opts.danger ?? false, resolve });
    });
}

/** Mount once near the app root. */
export function ConfirmHost() {
    const [request, setRequest] = useState<Request | null>(null);
    const confirmRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        show = setRequest;
        return () => {
            show = null;
        };
    }, []);
    useEffect(() => confirmRef.current?.focus(), [request]);

    if (!request) return null;
    const close = (ok: boolean) => {
        request.resolve(ok);
        setRequest(null);
    };
    return (
        <div className="modal-backdrop" onClick={() => close(false)} onKeyDown={e => e.key === 'Escape' && close(false)}>
            <div className="modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
                <p>{request.message}</p>
                <div className="modal-actions">
                    <button className="small-button" onClick={() => close(false)}>
                        Cancel
                    </button>
                    <button ref={confirmRef} className={request.danger ? 'danger-button' : 'primary-button'} onClick={() => close(true)}>
                        {request.confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
