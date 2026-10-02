import { STEPS, STATUS_LABEL, type StepKey, type StepStatus } from "./steps.ts";

export interface StepperProps {
  current: StepKey;
  statuses: Record<StepKey, StepStatus | null>;
  onSelect: (key: StepKey) => void;
}

/** Left rail on desktop, compact horizontal row on mobile (CSS only; labels stay in the a11y tree). */
export function Stepper({ current, statuses, onSelect }: StepperProps) {
  return (
    <nav className="wz-stepper" aria-label="Các bước thiết lập">
      <ol>
        {STEPS.map((s, i) => {
          const status = statuses[s.key];
          const isCurrent = s.key === current;
          return (
            <li key={s.key} className={isCurrent ? "is-current" : undefined}>
              <button
                type="button"
                className="wz-step"
                aria-current={isCurrent ? "step" : undefined}
                data-step={s.key}
                data-status={status ?? "unknown"}
                onClick={() => onSelect(s.key)}
              >
                <span className="wz-step-num" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="wz-step-text">
                  <span className="wz-step-label">{s.label}</span>
                  <span className="wz-step-status">
                    <span className={`wz-dot wz-dot-${status ?? "unknown"}`} aria-hidden="true" />
                    {status ? STATUS_LABEL[status] : "đang kiểm tra"}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
