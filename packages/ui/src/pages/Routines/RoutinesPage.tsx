import { RoutinesSection } from "./RoutinesSection.tsx";
import { EvalsSection } from "./EvalsSection.tsx";
import "./routines.css";

export function RoutinesPage() {
  return (
    <div className="routines-page">
      <div className="page-header">
        <h1>Routines & evals</h1>
      </div>
      <RoutinesSection />
      <EvalsSection />
    </div>
  );
}
