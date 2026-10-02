import { createContext, useContext, useEffect, useRef, type MutableRefObject } from "react";
import type { ReadinessReport } from "../../../api/readiness.ts";
import type { SetupJobState } from "./useSetupJob.ts";
import type { StepKey } from "./steps.ts";

/** What the current step exposes so the wizard can "save & continue". */
export interface StepController {
  dirty: boolean;
  /** Resolves true when everything was saved (or there was nothing to save). */
  save: () => Promise<boolean>;
}

export interface WizardCtx {
  report: ReadinessReport | null;
  readinessLoading: boolean;
  readinessError: string | null;
  refreshReadiness: () => void;
  jobs: SetupJobState;
  controllerRef: MutableRefObject<StepController | null>;
  setDirty: (dirty: boolean) => void;
  goStep: (key: StepKey) => void;
}

export const WizardContext = createContext<WizardCtx | null>(null);

export function useWizard(): WizardCtx {
  const ctx = useContext(WizardContext);
  if (!ctx) throw new Error("useWizard must be used within the setup wizard");
  return ctx;
}

/** Steps with their own state call this each render so the wizard knows about unsaved changes. */
export function useRegisterStep(dirty: boolean, save: () => Promise<boolean>): void {
  const { controllerRef, setDirty } = useWizard();
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const controller: StepController = { dirty, save: () => saveRef.current() };
    controllerRef.current = controller;
    setDirty(dirty);
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [dirty, controllerRef, setDirty]);
}
