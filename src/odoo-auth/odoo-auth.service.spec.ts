import { Test, TestingModule } from '@nestjs/testing';
import { OdooAuthService } from './odoo-auth.service';

describe('OdooAuthService', () => {
  let service: OdooAuthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [OdooAuthService],
    }).compile();

    service = module.get<OdooAuthService>(OdooAuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
