import type { FullResult, Reporter, TestResult } from '@playwright/test/reporter';

/** A green till gate means cases actually ran; missing fixture skips are red. */
export default class RequiredCases implements Reporter {
  private total = 0;
  private skipped = 0;

  onTestEnd(_test: unknown, result: TestResult): void {
    this.total += 1;
    if (result.status === 'skipped') this.skipped += 1;
  }

  async onEnd(result: FullResult): Promise<{ status: FullResult['status'] }> {
    return { status: this.total === 0 || this.skipped > 0 ? 'failed' : result.status };
  }
}
