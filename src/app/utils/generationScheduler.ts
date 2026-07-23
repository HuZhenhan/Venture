class GenerationScheduler {
  private timeoutIds: number[] = [];

  clear(): void {
    this.timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
    this.timeoutIds = [];
  }

  schedule(delay: number, callback: () => void): void {
    const timeoutId = window.setTimeout(() => {
      this.timeoutIds = this.timeoutIds.filter((id) => id !== timeoutId);
      callback();
    }, delay);

    this.timeoutIds.push(timeoutId);
  }
}

export const generationScheduler = new GenerationScheduler();
