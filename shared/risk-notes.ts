export function riskNotes(reasons: readonly string[]): string[] {
  return [
    ...new Set(
      reasons.flatMap((reason) =>
        reason
          .split(/[；;。]|\.(?=\s|$)/)
          .map((sentence) => sentence.trim())
          .filter(Boolean),
      ),
    ),
  ];
}
