import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SkillsService } from './skills.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';

describe('SkillsService', () => {
  let service: SkillsService;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SkillsService,
        { provide: SupabaseClientFactory, useValue: mockFactory },
      ],
    }).compile();

    service = module.get<SkillsService>(SkillsService);
    supabaseClientFactory = module.get(SupabaseClientFactory);
  });

  describe('createSkill', () => {
    it('should return skill object on success', async () => {
      const mockAdmin = {
        from: jest.fn().mockReturnValue({
          insert: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: {
                  id: 'skill-uuid',
                  name: 'AC Technician',
                  tenant_id: 'tenant-uuid',
                  created_at: '2026-06-20T00:00:00Z',
                },
                error: null,
              }),
            }),
          }),
        }),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);

      const result = await service.createSkill(ownerUser, {
        name: 'AC Technician',
      });

      expect(result).toEqual({
        id: 'skill-uuid',
        name: 'AC Technician',
        tenantId: 'tenant-uuid',
        createdAt: '2026-06-20T00:00:00Z',
      });
    });

    it('should throw 409 on duplicate skill name (23505)', async () => {
      const mockAdmin = {
        from: jest.fn().mockReturnValue({
          insert: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: null,
                error: { code: '23505', message: 'unique constraint' },
              }),
            }),
          }),
        }),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);

      await expect(
        service.createSkill(ownerUser, { name: 'AC Technician' }),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw 400 when owner has no tenantId', async () => {
      await expect(
        service.createSkill(ownerNoTenant, { name: 'AC Technician' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw 500 on generic DB error (non-23505)', async () => {
      const mockAdmin = {
        from: jest.fn().mockReturnValue({
          insert: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({
                data: null,
                error: { code: '08006', message: 'connection failure' },
              }),
            }),
          }),
        }),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);

      await expect(
        service.createSkill(ownerUser, { name: 'AC Technician' }),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('listSkills', () => {
    it('should return array of skills', async () => {
      const mockAdmin = {
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              order: jest.fn().mockResolvedValue({
                data: [
                  {
                    id: 'skill-1',
                    name: 'AC Technician',
                    tenant_id: 'tenant-uuid',
                    created_at: '2026-06-20T00:00:00Z',
                  },
                  {
                    id: 'skill-2',
                    name: 'Plumber',
                    tenant_id: 'tenant-uuid',
                    created_at: '2026-06-20T00:00:01Z',
                  },
                ],
                error: null,
              }),
            }),
          }),
        }),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);

      const result = await service.listSkills(ownerUser);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('AC Technician');
      expect(result[1].name).toBe('Plumber');
    });

    it('should return empty array when no skills', async () => {
      const mockAdmin = {
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              order: jest.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);

      const result = await service.listSkills(ownerUser);
      expect(result).toEqual([]);
    });

    it('should throw 400 when owner has no tenantId', async () => {
      await expect(service.listSkills(ownerNoTenant)).rejects.toThrow(
        BadRequestException,
      );
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });
  });

  describe('deleteSkill', () => {
    it('should return { success: true } when skill exists and is deleted', async () => {
      let fromCallCount = 0;
      const mockAdmin = {
        from: jest.fn().mockImplementation(() => {
          fromCallCount++;
          if (fromCallCount === 1) {
            return {
              select: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  eq: jest.fn().mockReturnValue({
                    single: jest.fn().mockResolvedValue({
                      data: { id: 'skill-uuid' },
                      error: null,
                    }),
                  }),
                }),
              }),
            };
          }
          return {
            delete: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockResolvedValue({ error: null }),
              }),
            }),
          };
        }),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);

      const result = await service.deleteSkill(ownerUser, 'skill-uuid');
      expect(result).toEqual({ success: true });
    });

    it('should throw 404 when skill not found or wrong tenant', async () => {
      let fromCallCount = 0;
      const mockAdmin = {
        from: jest.fn().mockImplementation(() => {
          fromCallCount++;
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: null,
                    error: { code: 'PGRST116' },
                  }),
                }),
              }),
            }),
          };
        }),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);

      await expect(
        service.deleteSkill(ownerUser, 'nonexistent-uuid'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw 500 when ownership SELECT fails with DB error', async () => {
      const mockAdmin = {
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: null,
                  error: { code: '08006', message: 'connection failure' },
                }),
              }),
            }),
          }),
        }),
      };
      supabaseClientFactory.createAdmin.mockReturnValue(mockAdmin as never);

      await expect(
        service.deleteSkill(ownerUser, 'skill-uuid'),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw 400 when owner has no tenantId', async () => {
      await expect(
        service.deleteSkill(ownerNoTenant, 'skill-uuid'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
