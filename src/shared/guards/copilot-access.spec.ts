import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

function getRolesDecoratorArguments(
  filePath: string,
  methodName: string,
): string[] {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  let roleArguments: string[] | undefined;

  const visit = (node: ts.Node) => {
    if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === methodName
    ) {
      const rolesDecorator = node.modifiers?.find((modifier) => {
        if (!ts.isDecorator(modifier)) {
          return false;
        }

        const expression = modifier.expression;
        return (
          ts.isCallExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          expression.expression.text === 'Roles'
        );
      });

      if (rolesDecorator && ts.isDecorator(rolesDecorator)) {
        const expression = rolesDecorator.expression;
        if (ts.isCallExpression(expression)) {
          roleArguments = expression.arguments.map((argument) =>
            argument.getText(sourceFile),
          );
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!roleArguments) {
    throw new Error(
      `Roles decorator not found for ${methodName} in ${filePath}`,
    );
  }

  return roleArguments;
}

describe('copilot scorer setup access source metadata', () => {
  const expectRolesToIncludeCopilot = (
    filePath: string,
    methodName: string,
  ) => {
    const roles = getRolesDecoratorArguments(filePath, methodName);

    expect(roles).toEqual(
      expect.arrayContaining(['UserRole.Admin', 'UserRole.Copilot']),
    );
  };

  const marathonMatchConfigControllerPath = path.resolve(
    __dirname,
    '../../api/marathon-match-config/marathon-match-config.controller.ts',
  );
  const testerControllerPath = path.resolve(
    __dirname,
    '../../api/tester/tester.controller.ts',
  );
  const submissionRunnerLogControllerPath = path.resolve(
    __dirname,
    '../../api/submission-runner-log/submission-runner-log.controller.ts',
  );

  it.each(['createConfig', 'getDefaults', 'getConfig', 'updateConfig'])(
    'allows copilots on marathon match config setup route %s',
    (methodName) => {
      expectRolesToIncludeCopilot(
        marathonMatchConfigControllerPath,
        methodName,
      );
    },
  );

  it.each(['createTester', 'createTesterVersion', 'getTester', 'listTesters'])(
    'allows copilots on tester setup route %s',
    (methodName) => {
      expectRolesToIncludeCopilot(testerControllerPath, methodName);
    },
  );

  it('allows copilots on submission runner log route', () => {
    expectRolesToIncludeCopilot(
      submissionRunnerLogControllerPath,
      'getRunnerLogs',
    );
  });

  it('allows managers on submission runner log route', () => {
    const roles = getRolesDecoratorArguments(
      submissionRunnerLogControllerPath,
      'getRunnerLogs',
    );

    expect(roles).toContain('UserRole.ProjectManager');
  });

  it('allows users on submission runner log route for owner checks', () => {
    const roles = getRolesDecoratorArguments(
      submissionRunnerLogControllerPath,
      'getRunnerLogs',
    );

    expect(roles).toContain('UserRole.User');
  });
});
