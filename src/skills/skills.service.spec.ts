import { Test, TestingModule } from '@nestjs/testing';
import { InternalServerErrorException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SkillsService } from './skills.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';

describe('SkillsService', () => {
  let service: SkillsService;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;
  let jwtService: { signAsync: jest.Mock };

  const ownerUser: RequestUser = {
    userId: 'owner-uuid',
    tenantId: 'tenant-uuid',
    role: Role.OWNER,
    rawJwt: 'mock-jwt',
  };

  const ownerNoTenant: RequestUser = {
    userId: 'owner-uuid',
    tenantId: null,
    role: Role.OWNER,
    rawJwt: 'mock-jwt',
  };

  beforeEach(async () => {
    const mockFactory = { create: jest.fn(), createAdmin: jest.fn() };
    jwtService = { signAsync: jest.fn().mockResolvedValue('minted-token') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SkillsService,
        { provide: SupabaseClientFactory, useValue: mockFactory },
        { provide: JwtService, useValue: jwtService },
      ],
    }).compile();

    service = module.get<SkillsService>(SkillsService);
    supabaseClientFactory = module.get(SupabaseClientFactory);
  });

  describe('listGlobalSkills', () => {
    const technicianUser: RequestUser = {
      userId: 'tech-uuid',
      tenantId: 'tenant-uuid',
      role: Role.TECHNICIAN,
      rawJwt: 'mock-jwt',
    };

    it('should mint an authenticated-role token and read through the JWT-scoped client', async () => {
      const fromSpy = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            order: jest.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      });
      supabaseClientFactory.create.mockReturnValue({ from: fromSpy } as never);

      await service.listGlobalSkills(ownerUser);

      expect(jwtService.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'owner-uuid',
          role: 'authenticated',
        }),
      );
      expect(supabaseClientFactory.create).toHaveBeenCalledWith('minted-token');
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
      expect(fromSpy).toHaveBeenCalledWith('skills');
    });

    it('should filter is_active and order by sort_order ascending', async () => {
      const order = jest.fn().mockResolvedValue({ data: [], error: null });
      const eq = jest.fn().mockReturnValue({ order });
      const select = jest.fn().mockReturnValue({ eq });
      supabaseClientFactory.create.mockReturnValue({
        from: jest.fn().mockReturnValue({ select }),
      } as never);

      await service.listGlobalSkills(ownerUser);

      expect(select).toHaveBeenCalledWith('id, name');
      expect(eq).toHaveBeenCalledWith('is_active', true);
      expect(order).toHaveBeenCalledWith('sort_order', { ascending: true });
    });

    it('should read the catalog without tenant context (owner before company setup)', async () => {
      // GET /skills is the global catalog — it must not require a tenantId
      // (the old tenant CRUD's 400 guard died with that CRUD in Story 4.2).
      const mockClient = {
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              order: jest.fn().mockResolvedValue({
                data: [{ id: 'skill-1', name: 'Plumbing' }],
                error: null,
              }),
            }),
          }),
        }),
      };
      supabaseClientFactory.create.mockReturnValue(mockClient as never);

      const result = await service.listGlobalSkills(ownerNoTenant);

      expect(result).toEqual([{ id: 'skill-1', name: 'Plumbing' }]);
      expect(supabaseClientFactory.create).toHaveBeenCalledWith('minted-token');
    });

    it('should return id/name pairs in query (seed) order', async () => {
      const rows = [
        { id: 'skill-1', name: 'Plumbing' },
        { id: 'skill-2', name: 'Electrical' },
        { id: 'skill-3', name: 'AC Service' },
      ];
      const mockClient = {
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              order: jest.fn().mockResolvedValue({ data: rows, error: null }),
            }),
          }),
        }),
      };
      supabaseClientFactory.create.mockReturnValue(mockClient as never);

      const result = await service.listGlobalSkills(ownerUser);

      expect(result).toEqual([
        { id: 'skill-1', name: 'Plumbing' },
        { id: 'skill-2', name: 'Electrical' },
        { id: 'skill-3', name: 'AC Service' },
      ]);
    });

    it('should work for any authenticated user (technician included)', async () => {
      const mockClient = {
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              order: jest.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      };
      supabaseClientFactory.create.mockReturnValue(mockClient as never);

      const result = await service.listGlobalSkills(technicianUser);
      expect(result).toEqual([]);
      expect(supabaseClientFactory.create).toHaveBeenCalledWith('minted-token');
    });

    it('should return empty array when the catalog has no rows', async () => {
      const mockClient = {
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              order: jest.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      };
      supabaseClientFactory.create.mockReturnValue(mockClient as never);

      const result = await service.listGlobalSkills(ownerUser);
      expect(result).toEqual([]);
    });

    it('should throw 500 on DB error', async () => {
      const mockClient = {
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              order: jest.fn().mockResolvedValue({
                data: null,
                error: { code: '08006', message: 'connection failure' },
              }),
            }),
          }),
        }),
      };
      supabaseClientFactory.create.mockReturnValue(mockClient as never);

      await expect(service.listGlobalSkills(ownerUser)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
