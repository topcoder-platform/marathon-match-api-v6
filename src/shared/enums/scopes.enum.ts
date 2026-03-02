/**
 * Enum defining all the possible scopes for M2M tokens
 */
export enum Scope {
  // Marathon match scopes
  CreateMarathonMatch = 'create:marathon-match',
  ReadMarathonMatch = 'read:marathon-match',
  UpdateMarathonMatch = 'update:marathon-match',
  DeleteMarathonMatch = 'delete:marathon-match',
  AllMarathonMatch = 'all:marathon-match',

  // Marathon match tester scopes
  CreateMarathonMatchTester = 'create:marathon-match-tester',
  ReadMarathonMatchTester = 'read:marathon-match-tester',
  UpdateMarathonMatchTester = 'update:marathon-match-tester',
  DeleteMarathonMatchTester = 'delete:marathon-match-tester',
  AllMarathonMatchTester = 'all:marathon-match-tester',
}

/**
 * Maps AllScope types to the corresponding individual scopes
 */
export const ALL_SCOPE_MAPPINGS: Record<string, string[]> = {
  [Scope.AllMarathonMatch]: [
    Scope.CreateMarathonMatch,
    Scope.ReadMarathonMatch,
    Scope.UpdateMarathonMatch,
    Scope.DeleteMarathonMatch,
  ],
  [Scope.AllMarathonMatchTester]: [
    Scope.CreateMarathonMatchTester,
    Scope.ReadMarathonMatchTester,
    Scope.UpdateMarathonMatchTester,
    Scope.DeleteMarathonMatchTester,
  ],
};
