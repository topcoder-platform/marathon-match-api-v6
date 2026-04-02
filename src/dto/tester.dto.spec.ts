import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateTesterDto, CreateTesterVersionDto } from './tester.dto';

describe('Tester DTO validation', () => {
  const validationPipe = new ValidationPipe({
    whitelist: true,
    transform: true,
  });

  it('rejects whitespace-only tester fields when creating a tester', async () => {
    await expect(
      validationPipe.transform(
        {
          name: '   ',
          version: '\t',
          sourceCode: '\n  ',
          className: '  ',
        },
        {
          type: 'body',
          metatype: CreateTesterDto,
          data: '',
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects whitespace-only tester fields when creating a tester version', async () => {
    await expect(
      validationPipe.transform(
        {
          version: '   ',
          sourceCode: '\n\t',
          className: '    ',
        },
        {
          type: 'body',
          metatype: CreateTesterVersionDto,
          data: '',
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts source code that includes indentation before real content', async () => {
    await expect(
      validationPipe.transform(
        {
          name: 'Bridge Runners',
          version: '1.0.0',
          sourceCode: '\n  public class Tester { }\n',
          className: 'com.topcoder.mm.Tester',
        },
        {
          type: 'body',
          metatype: CreateTesterDto,
          data: '',
        },
      ),
    ).resolves.toMatchObject({
      name: 'Bridge Runners',
      version: '1.0.0',
      sourceCode: '\n  public class Tester { }\n',
      className: 'com.topcoder.mm.Tester',
    });
  });
});
