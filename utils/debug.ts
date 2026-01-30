// debug logger that only logs when not in production mode
// controlled by NODE_ENV environment variable

const isProduction = process.env.NODE_ENV === "production";

export function debug(...args: unknown[]): void {
  if (!isProduction) {
    console.log(...args);
  }
}

// re-export for convenience
export const isDev = !isProduction;
