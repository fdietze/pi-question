export type QuestionPresentationState = "shown" | "minimized";

/**
 * Pure state machine for disposable dock presentations.
 *
 * Inversion: each transition invalidates older generation callbacks, so stale
 * components cannot minimize or settle the run after a newer presentation wins.
 */
export class QuestionPresentationLifecycle {
  private generation = 0;
  private currentState: QuestionPresentationState = "minimized";
  private settled = false;

  state(): QuestionPresentationState {
    return this.currentState;
  }

  /** Starts a fresh presentation when the run is currently minimized. */
  show(): number | undefined {
    if (this.settled || this.currentState === "shown") return undefined;
    this.currentState = "shown";
    this.generation += 1;
    return this.generation;
  }

  /** Minimizes the current presentation. Omit generation for controller calls. */
  minimize(generation?: number): boolean {
    if (
      this.settled ||
      this.currentState !== "shown" ||
      (generation !== undefined && generation !== this.generation)
    ) {
      return false;
    }
    this.currentState = "minimized";
    this.generation += 1;
    return true;
  }

  /** Settles the run once. Omit generation for controller/abort calls. */
  settle(generation?: number): boolean {
    if (
      this.settled ||
      (generation !== undefined && generation !== this.generation)
    ) {
      return false;
    }
    this.settled = true;
    this.generation += 1;
    return true;
  }

  isCurrent(generation: number): boolean {
    return !this.settled && generation === this.generation;
  }

  isSettled(): boolean {
    return this.settled;
  }
}
