import { ConfigService } from '@nestjs/config';
import { createPlacesProvider } from './places.module';
import { GooglePlacesProvider } from './google-places.provider';
import { MockPlacesProvider } from './mock-places.provider';

describe('createPlacesProvider (PlacesModule NODE_ENV binding)', () => {
  const configService = {
    getOrThrow: jest.fn().mockReturnValue('test-google-api-key'),
  } as unknown as ConfigService;
  const originalNodeEnv = process.env['NODE_ENV'];

  afterEach(() => {
    process.env['NODE_ENV'] = originalNodeEnv;
  });

  it('resolves GooglePlacesProvider when NODE_ENV=production', () => {
    process.env['NODE_ENV'] = 'production';

    expect(createPlacesProvider(configService)).toBeInstanceOf(
      GooglePlacesProvider,
    );
  });

  it('resolves MockPlacesProvider when NODE_ENV is not production', () => {
    process.env['NODE_ENV'] = 'test';

    expect(createPlacesProvider(configService)).toBeInstanceOf(
      MockPlacesProvider,
    );
  });
});
