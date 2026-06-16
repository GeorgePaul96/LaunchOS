export class LaunchOSApiError extends Error {
  constructor(public status: number, public code: string, public detail: string) {
    super(`${code}: ${detail}`);
    this.name = "LaunchOSApiError";
  }
}
