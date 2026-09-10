export interface ISizeCalculationResult {
  width: number;
  height: number;
  type?: string;
}

declare function imageSize(input: Uint8Array | string): ISizeCalculationResult;
declare function imageSize(
  input: string,
  callback: (error: Error | null, result?: ISizeCalculationResult) => void,
): void;

export = imageSize;
