import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In, Not, IsNull } from 'typeorm';
import {
  Hostel,
  Room,
  RoomStatus,
  RoomType,
  AllocationRule,
  AllocationRun,
  AllocationRunStatus,
  AllocationMode,
  AllocationResult,
  Group,
  GroupMembership,
  MembershipStatus,
  Student,
  WingParticipationSetting,
  SystemSetting,
  AdministrativeAction,
  ActionType,
} from '../entities';
import {
  CreateHostelDto,
  UpdateHostelDto,
  CreateRoomDto,
  UpdateRoomDto,
  CreateRuleDto,
  UpdateRuleDto,
  BulkCreateRoomsDto,
  UpdateSystemSettingDto,
} from './dto/admin.dto';

export interface StudentEligibility {
  enabled: boolean;
  showRoommateLimits?: boolean;
  showBatchCapacity?: boolean;
  globalMaxGroupSize?: number;
  globalMaxRoommates?: number;
  hostels: {
    id: number;
    name: string;
    wings: {
      name: string;
      maxRoommates: number;
      totalSpots: number;
    }[];
  }[];
}

import { ConfigService } from '@nestjs/config';
import { DecisionsService } from '../decisions/decisions.service';

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(Hostel)
    private hostelRepository: Repository<Hostel>,
    @InjectRepository(Room)
    private roomRepository: Repository<Room>,
    @InjectRepository(AllocationRule)
    private ruleRepository: Repository<AllocationRule>,
    @InjectRepository(AllocationRun)
    private runRepository: Repository<AllocationRun>,
    @InjectRepository(AllocationResult)
    private resultRepository: Repository<AllocationResult>,
    @InjectRepository(Group)
    private groupRepository: Repository<Group>,
    @InjectRepository(GroupMembership)
    private membershipRepository: Repository<GroupMembership>,
    @InjectRepository(Student)
    private studentRepository: Repository<Student>,
    @InjectRepository(WingParticipationSetting)
    private wingParticipationRepository: Repository<WingParticipationSetting>,
    @InjectRepository(SystemSetting)
    private systemSettingRepository: Repository<SystemSetting>,
    @InjectRepository(AdministrativeAction)
    private actionRepository: Repository<AdministrativeAction>,
    private configService: ConfigService,
    private decisionsService: DecisionsService,
    private dataSource: DataSource,
  ) {}

  // ============ HOSTEL MANAGEMENT ============

  async createHostel(createHostelDto: CreateHostelDto): Promise<Hostel> {
    const existing = await this.hostelRepository.findOne({
      where: { name: createHostelDto.name },
    });

    if (existing) {
      throw new ConflictException('Hostel with this name already exists');
    }

    const hostel = this.hostelRepository.create(createHostelDto);
    return this.hostelRepository.save(hostel);
  }

  async getAllHostels(): Promise<Hostel[]> {
    return this.hostelRepository.find({
      order: { name: 'ASC' },
    });
  }

  async getHostelHierarchy() {
    const hostels = await this.hostelRepository.find({
      order: { name: 'ASC' },
      relations: ['rooms'],
    });

    return hostels.map((hostel) => {
      const floorsMap = new Map<number, any>();

      hostel.rooms.forEach((room) => {
        const floorNum = room.floor || 0;
        if (!floorsMap.has(floorNum)) {
          floorsMap.set(floorNum, {
            floor: floorNum,
            wings: new Map<string, any>(),
          });
        }

        const floor = floorsMap.get(floorNum);
        const wingName = room.wing || 'Default';
        const capacityType = room.roomType || (room.capacity === 1 ? 'Single' : room.capacity === 2 ? 'Double' : 'Triple');
        
        const wingKey = `${wingName}-${capacityType}`;
        
        if (!floor.wings.has(wingKey)) {
          floor.wings.set(wingKey, {
            wing: wingName,
            roomCount: 0,
            capacityType: capacityType,
          });
        }

        const wing = floor.wings.get(wingKey);
        wing.roomCount++;
      });

      return {
        id: hostel.id,
        name: hostel.name,
        genderType: hostel.genderType,
        floors: Array.from(floorsMap.values())
          .sort((a, b) => a.floor - b.floor)
          .map((f) => ({
            floor: f.floor,
            wings: Array.from(f.wings.values()).sort((a: any, b: any) =>
              a.wing.localeCompare(b.wing),
            ),
          })),
      };
    });
  }

  async getHostelById(id: number): Promise<Hostel> {
    if (isNaN(id)) {
      throw new BadRequestException('Invalid hostel ID');
    }
    const hostel = await this.hostelRepository.findOne({ where: { id } });
    if (!hostel) {
      throw new NotFoundException('Hostel not found');
    }
    return hostel;
  }

  async updateHostel(
    id: number,
    updateHostelDto: UpdateHostelDto,
  ): Promise<Hostel> {
    const hostel = await this.getHostelById(id);
    Object.assign(hostel, updateHostelDto);
    return this.hostelRepository.save(hostel);
  }

  async deleteHostel(id: number): Promise<{ message: string }> {
    const hostel = await this.getHostelById(id);

    // Check if there are rooms in this hostel
    const roomCount = await this.roomRepository.count({
      where: { hostelId: id },
    });

    if (roomCount > 0) {
      throw new BadRequestException(
        'Cannot delete hostel with rooms. Delete rooms first.',
      );
    }

    await this.hostelRepository.remove(hostel);
    return { message: 'Hostel deleted successfully' };
  }

  // ============ ROOM MANAGEMENT ============

  async createRoom(createRoomDto: CreateRoomDto): Promise<Room> {
    // Verify hostel exists
    await this.getHostelById(createRoomDto.hostelId);

    const existing = await this.roomRepository.findOne({
      where: {
        hostelId: createRoomDto.hostelId,
        roomNumber: createRoomDto.roomNumber,
      },
    });

    if (existing) {
      throw new ConflictException(
        'Room with this number already exists in this hostel',
      );
    }

    const room = this.roomRepository.create({
      ...createRoomDto,
      roomType: (createRoomDto.roomType as RoomType) || RoomType.DOUBLE,
    });
    return this.roomRepository.save(room);
  }

  async bulkCreateRooms(dto: BulkCreateRoomsDto): Promise<Room[]> {
    // Verify hostel exists
    await this.getHostelById(dto.hostelId);

    const rooms: Room[] = [];
    for (let i = 0; i < dto.count; i++) {
      const roomNumber = `${dto.startRoomNumber + i}`;
      const existing = await this.roomRepository.findOne({
        where: { hostelId: dto.hostelId, roomNumber },
      });

      if (!existing) {
        const room = this.roomRepository.create({
          hostelId: dto.hostelId,
          roomNumber,
          wing: dto.wing,
          floor: dto.floor,
          capacity: dto.capacity,
          roomType: (dto.roomType as RoomType) || RoomType.DOUBLE,
        });
        rooms.push(room);
      }
    }

    return this.roomRepository.save(rooms);
  }

  async getAllRooms(hostelId?: number): Promise<Room[]> {
    const where = hostelId ? { hostelId } : {};
    return this.roomRepository.find({
      where,
      relations: ['hostel'],
      order: { hostelId: 'ASC', wing: 'ASC', floor: 'ASC', roomNumber: 'ASC' },
    });
  }

  async getRoomById(id: number): Promise<Room> {
    const room = await this.roomRepository.findOne({
      where: { id },
      relations: ['hostel'],
    });
    if (!room) {
      throw new NotFoundException('Room not found');
    }
    return room;
  }

  async updateRoom(id: number, updateRoomDto: UpdateRoomDto): Promise<Room> {
    const room = await this.getRoomById(id);
    Object.assign(room, updateRoomDto);
    return this.roomRepository.save(room);
  }

  async deleteRoom(id: number): Promise<{ message: string }> {
    const room = await this.getRoomById(id);
    await this.roomRepository.remove(room);
    return { message: 'Room deleted successfully' };
  }

  // ============ ALLOCATION RULES ============

  async createRule(createRuleDto: CreateRuleDto): Promise<AllocationRule> {
    if (createRuleDto.hostelId) {
      await this.getHostelById(createRuleDto.hostelId);
    }

    const rule = this.ruleRepository.create(createRuleDto);
    return this.ruleRepository.save(rule);
  }

  async getAllRules(): Promise<AllocationRule[]> {
    return this.ruleRepository.find({
      relations: ['hostel'],
      order: { priority: 'DESC', id: 'ASC' },
    });
  }

  async getRunById(id: string): Promise<AllocationRun> {
    const run = await this.runRepository.findOne({
      where: { id },
    });
    if (!run) {
      throw new NotFoundException('Run not found');
    }
    return run;
  }

  async getRuleById(id: number): Promise<AllocationRule> {
    const rule = await this.ruleRepository.findOne({
      where: { id },
      relations: ['hostel'],
    });
    if (!rule) {
      throw new NotFoundException('Rule not found');
    }
    return rule;
  }

  async updateRule(
    id: number,
    updateRuleDto: UpdateRuleDto,
  ): Promise<AllocationRule> {
    const rule = await this.getRuleById(id);
    if (updateRuleDto.hostelId) {
      await this.getHostelById(updateRuleDto.hostelId);
    }
    Object.assign(rule, updateRuleDto);
    return this.ruleRepository.save(rule);
  }

  async deleteRule(id: number): Promise<{ message: string }> {
    const rule = await this.getRuleById(id);
    await this.ruleRepository.remove(rule);
    return { message: 'Rule deleted successfully' };
  }

  // ============ ALLOCATION RUNS ============

  async triggerAllocation(
    userId: string,
    allocationMode: AllocationMode = AllocationMode.GROUP_BASED,
    targetYears?: number[],
    targetPrograms?: string[],
  ): Promise<AllocationRun> {
    const queryRunner = this.runRepository.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Check if there's an un-finalized draft or running allocation
      const pendingRun = await queryRunner.manager.findOne(AllocationRun, {
        where: [
          { status: AllocationRunStatus.QUEUED },
          { status: AllocationRunStatus.RUNNING },
          { status: AllocationRunStatus.COMPLETED, finalized: false }
        ]
      });

      if (pendingRun) {
        throw new BadRequestException(
          'Cannot trigger new allocation. Please Publish & Commit (or delete) your current draft first.',
        );
      }

      // Get current rules for snapshot
      const rules = await queryRunner.manager.find(AllocationRule);

      // Create allocation run record
      const run = queryRunner.manager.create(AllocationRun, {
        triggeredById: userId,
        status: AllocationRunStatus.QUEUED,
        allocationMode,
        targetYears: targetYears || null,
        targetPrograms: targetPrograms || null,
        rulesSnapshot: rules.map((r) => ({
          id: r.id,
          hostelId: r.hostelId,
          year: r.year,
          roomType: r.roomType,
          isAllowed: r.isAllowed,
          priority: r.priority,
          wing: r.wing,
        })),
      });

      const savedRun = await queryRunner.manager.save(AllocationRun, run);
      await queryRunner.commitTransaction();

      // Trigger background processing (no need to wait for it)
      this.processAllocationInBackground(savedRun.id, rules, allocationMode, targetYears, targetPrograms);

      return savedRun;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  private async processAllocationInBackground(runId: string, rules: AllocationRule[], allocationMode: AllocationMode, targetYears?: number[], targetPrograms?: string[]) {
    this.callAllocationEngine(runId, rules, allocationMode, targetYears, targetPrograms).catch((error) => {
      console.error('Allocation engine error:', error);
      this.updateRunStatus(runId, AllocationRunStatus.FAILED, error.message);
    });
  }

  private async callAllocationEngine(
    runId: string,
    rules: AllocationRule[],
    allocationMode: AllocationMode,
    targetYears?: number[],
    targetPrograms?: string[],
  ): Promise<void> {
    const allocationEngineUrl = this.configService.get(
      'ALLOCATION_ENGINE_URL',
      'http://localhost:8000',
    );

    try {
      await this.updateRunStatus(runId, AllocationRunStatus.RUNNING);

      // Build locked_assignments map from all currently locked results
      const lockedResults = await this.resultRepository.find({
        where: { isLocked: true },
      });
      const lockedAssignments: Record<number, string[]> = {};
      for (const r of lockedResults) {
        if (r.roomId == null) continue;
        if (!lockedAssignments[r.roomId]) lockedAssignments[r.roomId] = [];
        lockedAssignments[r.roomId].push(r.studentId);
      }

      const response = await fetch(`${allocationEngineUrl}/allocate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          allocation_run_id: runId,
          allocation_mode: allocationMode,
          rules: rules.map((r) => ({
            id: r.id,
            hostel_id: r.hostelId,
            year: r.year,
            room_type: r.roomType,
            is_allowed: r.isAllowed,
            priority: r.priority,
            wing: r.wing,
          })),
          locked_assignments: lockedAssignments,
          target_years: targetYears ?? [],
          target_programs: targetPrograms ?? [],
        }),
      });

      const data = await response.json();

      // The allocation engine runs asynchronously, so we just check it was queued
      if (data.status === 'queued') {
        // Poll for completion (in production, use webhooks or message queue)
        this.pollAllocationStatus(runId, allocationEngineUrl);
      }
    } catch (error: any) {
      await this.updateRunStatus(
        runId,
        AllocationRunStatus.FAILED,
        error.message,
      );
    }
  }

  private async pollAllocationStatus(
    runId: string,
    engineUrl: string,
  ): Promise<void> {
    const maxAttempts = 60; // 5 minutes with 5-second intervals
    let attempts = 0;

    const poll = async () => {
      try {
        const response = await fetch(`${engineUrl}/allocation/${runId}`);
        const data = await response.json();

        if (data.status === 'completed') {
          await this.saveAllocationResults(runId, data);
          await this.updateRunStatus(
            runId,
            AllocationRunStatus.COMPLETED,
            undefined,
            data.total_students,
            data.allocated_students,
          );
        } else if (data.status === 'failed') {
          await this.updateRunStatus(
            runId,
            AllocationRunStatus.FAILED,
            data.error || 'Unknown error',
          );
        } else if (attempts < maxAttempts) {
          attempts++;
          setTimeout(poll, 5000); // Poll every 5 seconds
        } else {
          await this.updateRunStatus(
            runId,
            AllocationRunStatus.FAILED,
            'Allocation timeout',
          );
        }
      } catch (error: any) {
        if (attempts < maxAttempts) {
          attempts++;
          setTimeout(poll, 5000);
        } else {
          await this.updateRunStatus(
            runId,
            AllocationRunStatus.FAILED,
            'Failed to get allocation status',
          );
        }
      }
    };

    setTimeout(poll, 2000); // Start polling after 2 seconds
  }

  private async saveAllocationResults(runId: string, data: any): Promise<void> {
    const allocations = data.allocations || [];
    const decisionLogs = data.decision_logs || [];

    // Save allocation results
    for (const alloc of allocations) {
      const result = this.resultRepository.create({
        runId,
        studentId: alloc.student_id,
        roomId: alloc.room_id,
        hostelName: alloc.hostel_name,
        roomNumber: alloc.room_number,
        wing: alloc.wing,
        floor: alloc.floor,
        groupId: alloc.group_id,
        happiness: alloc.happiness ?? 50,
      });

      await this.resultRepository.save(result);
    }

    // Save decision logs for transparency
    if (decisionLogs.length > 0) {
      await this.decisionsService.saveDecisions(runId, decisionLogs);
    }
  }

  private async updateRunStatus(
    runId: string,
    status: AllocationRunStatus,
    errorMessage?: string,
    totalStudents?: number,
    allocatedStudents?: number,
  ): Promise<void> {
    const run = await this.runRepository.findOne({ where: { id: runId } });
    if (run) {
      run.status = status;
      if (errorMessage) run.errorMessage = errorMessage;
      if (totalStudents !== undefined) run.totalStudents = totalStudents;
      if (allocatedStudents !== undefined)
        run.allocatedStudents = allocatedStudents;
      if (
        status === AllocationRunStatus.COMPLETED ||
        status === AllocationRunStatus.FAILED
      ) {
        run.endTime = new Date();
      }
      await this.runRepository.save(run);
    }
  }

  async getAllocationRuns(): Promise<AllocationRun[]> {
    return this.runRepository.find({
      relations: ['triggeredBy'],
      order: { startTime: 'DESC' },
    });
  }

  async getAllocationRunById(id: string): Promise<AllocationRun> {
    const run = await this.runRepository.findOne({
      where: { id },
      relations: ['triggeredBy'],
    });
    if (!run) {
      throw new NotFoundException('Allocation run not found');
    }
    return run;
  }

  async deleteAllocationRun(id: string) {
    const run = await this.runRepository.findOne({ where: { id } });
    if (!run) {
      throw new NotFoundException('Allocation run not found');
    }

    if (run.finalized) {
      throw new BadRequestException('Cannot delete a finalized allocation run');
    }

    // Delete associated results first
    await this.resultRepository.delete({ runId: id });
    
    // Delete the run record
    await this.runRepository.remove(run);

    return { message: 'Allocation run and associated results deleted successfully.' };
  }

  async publishAndCommitRun(id: string): Promise<{ message: string; count: number }> {
    return await this.dataSource.transaction(async (manager) => {
      // 1. Fetch the run
      const run = await manager.findOne(AllocationRun, { where: { id } });
      if (!run) {
        throw new NotFoundException('Allocation run not found');
      }

      // Step A: Finalize
      if (run.status !== AllocationRunStatus.COMPLETED) {
        throw new BadRequestException('Only completed allocation runs can be published');
      }
      if (run.finalized) {
        throw new BadRequestException('Allocation run is already published');
      }

      // [CRITICAL] Capture PRE-COMMIT Snapshot for Undo
      // We must do this BEFORE any updates (reset, finalized, etc.)
      const studentEntitiesInCohort = await manager.find(Student, {
        where: run.targetYears && run.targetYears.length > 0 
          ? { year: In(run.targetYears) } 
          : {}
      });
      
      const snapshot: Record<string, { roomId: number | null; applicationStatus: string; hasSubmitted: boolean }> = {};
      for (const s of studentEntitiesInCohort) {
        snapshot[s.userId] = {
          roomId: s.currentRoomId,
          applicationStatus: s.applicationStatus,
          hasSubmitted: s.hasSubmitted,
        };
      }

      run.finalized = true;
      await manager.save(AllocationRun, run);

      // 2. Fetch all results for this run
      const results = await manager.find(AllocationResult, { where: { runId: id } });
      
      // Filter for successful assignments (with a room)
      const successfulResults = results.filter((r) => r.roomId != null);

      if (successfulResults.length === 0) {
        // Log the action even if empty for consistency
        const actionLog = this.actionRepository.create({
          actionType: ActionType.PUBLISH_RUN,
          performedBy: 'WARDEN_ADMIN',
          description: `Allocation Run Committed (0 students)`,
          snapshot: snapshot as any,
          metadata: { runId: id },
        });
        await manager.save(AdministrativeAction, actionLog);
        return { message: 'Run published, but no assignments were found to commit.', count: 0 };
      }

      // Step B: Lock Results (Sets isLocked = true to fence off from engine)
      for (const res of successfulResults) {
        res.isLocked = true;
      }
      await manager.save(AllocationResult, successfulResults);

      // Step C: Commit Rooms (Update status to OCCUPIED)
      const roomIds = [...new Set(successfulResults.map((r) => r.roomId))];
      
      // Vacate Old Rooms logic:
      // Find the current room IDs of all students in this run
      const studentIds = successfulResults.map((r) => r.studentId);
      const studentEntities = await manager.find(Student, {
        where: { userId: In(studentIds) },
      });

      const oldRoomIdsToVacate = studentEntities
        .map((s) => s.currentRoomId)
        .filter((id) => id !== null && !roomIds.includes(id));

      // 1. Vacate old rooms that aren't being re-claimed in this run
      if (oldRoomIdsToVacate.length > 0) {
        await manager
          .createQueryBuilder()
          .update(Room)
          .set({ status: RoomStatus.AVAILABLE })
          .whereInIds(oldRoomIdsToVacate)
          .execute();
      }

      // 2. Claim new rooms (OCCUPIED)
      await manager
        .createQueryBuilder()
        .update(Room)
        .set({ status: RoomStatus.OCCUPIED })
        .whereInIds(roomIds)
        .execute();

      // Step D: Commit Students (Update currentRoomId and allocatedRoomId)
      for (const res of successfulResults) {
        await manager.update(
          Student,
          { userId: res.studentId },
          {
            currentRoomId: res.roomId,
            allocatedRoomId: res.roomId,
          },
        );
      }

      // Step E: Reset Application Status for target cohorts
      const resetQuery = manager
        .createQueryBuilder()
        .update(Student)
        .set({
          hasSubmitted: false,
          applicationStatus: 'NONE',
        });

      if (run.targetYears && run.targetYears.length > 0) {
        resetQuery.where('year IN (:...years)', { years: run.targetYears });
      }

      await resetQuery.execute();

      // Step F: Log the action
      const actionLog = this.actionRepository.create({
        actionType: ActionType.PUBLISH_RUN,
        performedBy: 'WARDEN_ADMIN',
        description: `Allocation Run Committed (${successfulResults.length} students)`,
        snapshot: snapshot as any,
        metadata: { runId: id },
      });
      await manager.save(AdministrativeAction, actionLog);

      return {
        message: 'Allocation published and committed successfully.',
        count: successfulResults.length,
      };
    });
  }

  async bulkEvictStudents(rollNumbers: string[]) {
    return await this.dataSource.transaction(async (manager) => {
      // 1. Find students
      const students = await manager.find(Student, {
        where: rollNumbers.map((rn) => ({ rollNumber: rn })),
      });

      if (students.length === 0) {
        throw new BadRequestException('No students found for the provided roll numbers');
      }

      const studentIds = students.map((s) => s.userId);

      // 2. Find their allocation results (active assignments)
      const results = await manager.find(AllocationResult, {
        where: studentIds.map((sid) => ({ studentId: sid, roomId: Not(IsNull()) })),
      });

      console.log(`[BulkEvict] Processing ${rollNumbers.length} roll numbers:`, rollNumbers);
      console.log(`[BulkEvict] Found ${students.length} students in DB.`);

      const summary: any[] = [];
      const roomIdsToFree: number[] = [];

      for (const student of students) {
        const result = results.find((r) => r.studentId === student.userId);
        if (result) {
          summary.push({
            rollNumber: student.rollNumber,
            fullName: student.fullName,
            roomNumber: result.roomNumber,
            hostelName: result.hostelName,
            status: 'room_freed',
          });
          roomIdsToFree.push(result.roomId);
        } else {
          summary.push({
            rollNumber: student.rollNumber,
            fullName: student.fullName,
            roomNumber: 'None',
            hostelName: 'N/A',
            status: 'status_reset',
          });
        }
      }

      if (roomIdsToFree.length > 0) {
        // Step A: Mark rooms as available
        await manager
          .createQueryBuilder()
          .update(Room)
          .set({ status: RoomStatus.AVAILABLE })
          .whereInIds([...new Set(roomIdsToFree)])
          .execute();

        // Step B: Delete allocation results (removes the "locked" bed from engine view)
        await manager.delete(AllocationResult, {
          id: In(results.map((r) => r.id)),
        });
      }

      // Step C: Clear student room profiles (ALWAYS do this for students we found)
      if (studentIds.length > 0) {
        await manager.update(
          Student,
          { userId: In(studentIds) },
          {
            currentRoomId: null,
            allocatedRoomId: null,
            hasSubmitted: false,
            applicationStatus: 'EVICTED',
          },
        );
      }

      // Step D: Log the action for Undo
      const snapshot: Record<string, { 
        roomId: number | null; 
        applicationStatus: string; 
        hasSubmitted: boolean;
        allocationResult?: any;
      }> = {};

      for (const s of students) {
        const result = results.find((r) => r.studentId === s.userId);
        snapshot[s.userId] = {
          roomId: s.currentRoomId,
          applicationStatus: s.applicationStatus,
          hasSubmitted: s.hasSubmitted,
          allocationResult: result || null,
        };
      }

      const actionLog = this.actionRepository.create({
        actionType: ActionType.EVICTION,
        performedBy: 'WARDEN_ADMIN',
        description: `Bulk Eviction of ${students.length} students`,
        snapshot: snapshot as any,
      });
      await manager.save(AdministrativeAction, actionLog);

      return {
        message: `Successfully evicted ${summary.length} students.`,
        summary,
      };
    });
  }

  async resetApplicationStatus(year?: number) {
    const updateQuery = this.studentRepository
      .createQueryBuilder()
      .update(Student)
      .set({
        hasSubmitted: false,
        applicationStatus: 'NONE',
      });

    if (year) {
      updateQuery.where('year = :year', { year });
    }

    await updateQuery.execute();

    // Also disband groups for this cohort to maintain data hygiene
    const students = await this.studentRepository.find({
      where: year ? { year } : {},
      select: ['userId'],
    });
    const studentIds = students.map((s) => s.userId);

    if (studentIds.length > 0) {
      const memberships = await this.membershipRepository.find({
        where: { userId: In(studentIds) },
        select: ['groupId'],
      });
      const groupIds = [...new Set(memberships.map((m) => m.groupId))];
      if (groupIds.length > 0) {
        await this.groupRepository.delete(groupIds);
      }
    }

    return {
      message: `Application status reset and groups disbanded successfully for ${year ? `Year ${year}` : 'all students'}.`,
    };
  }

  async getAdminActions(): Promise<AdministrativeAction[]> {
    return this.actionRepository.find({
      order: { timestamp: 'DESC' },
      take: 20,
    });
  }

  async rollbackAction(actionId: string) {
    return await this.dataSource.transaction(async (manager) => {
      const action = await manager.findOneBy(AdministrativeAction, { id: actionId });
      if (!action) throw new NotFoundException('Action log not found');
      if (action.isReverted) throw new BadRequestException('Action already reverted');

      const snapshot = action.snapshot as Record<string, any>;
      const studentIds = Object.keys(snapshot);

      // 1. Identify all rooms that will be involved
      // Current rooms (to be vacated)
      const students = await manager.find(Student, { where: { userId: In(studentIds) } });
      const roomsToVacate = students
        .map(s => s.currentRoomId)
        .filter(id => id !== null) as number[];
      
      // Previous rooms (to be re-occupied)
      const roomsToOccupy = Object.values(snapshot)
        .map(v => v.roomId)
        .filter(id => id !== null) as number[];

      // 2. Restore students and allocation results
      for (const studentId of studentIds) {
        const previousState = snapshot[studentId];
        await manager.update(Student, { userId: studentId }, {
          currentRoomId: previousState.roomId,
          allocatedRoomId: previousState.roomId,
          applicationStatus: previousState.applicationStatus,
          hasSubmitted: previousState.hasSubmitted, 
        });

        // Restore AllocationResult if it was part of an eviction
        if (action.actionType === ActionType.EVICTION && previousState.allocationResult) {
          const resultData = previousState.allocationResult;
          // Create a new entity from the saved data
          const restoredResult = manager.create(AllocationResult, {
            ...resultData,
            // Ensure we don't accidentally link to a non-existent group if it was disbanded
            // though SET NULL should have handled this in the snapshot already
          });
          await manager.save(AllocationResult, restoredResult);
        }
      }

      // 3. Reset room statuses
      if (roomsToVacate.length > 0) {
        await manager.update(Room, { id: In(roomsToVacate) }, { status: RoomStatus.AVAILABLE });
      }
      if (roomsToOccupy.length > 0) {
        await manager.update(Room, { id: In(roomsToOccupy) }, { status: RoomStatus.OCCUPIED });
      }

      if (action.actionType === ActionType.PUBLISH_RUN && action.metadata?.runId) {
        const runId = action.metadata.runId;
        const run = await manager.findOne(AllocationRun, { where: { id: runId } });
        if (run) {
          run.finalized = false;
          await manager.save(AllocationRun, run);

          // Unlock results so they can be viewed/edited as draft again
          await manager.update(AllocationResult, { runId }, { isLocked: false });
          console.log(`[Rollback] Un-finalized run ${runId} and unlocked results`);
        }
      }

      // 5. Mark action as reverted
      action.isReverted = true;
      await manager.save(AdministrativeAction, action);

      return { message: 'Rollback completed successfully' };
    });
  }

  async getAllocationResults(runId: string): Promise<AllocationResult[]> {
    return this.resultRepository.find({
      where: { runId },
      relations: ['student', 'room', 'group'],
      order: { happiness: 'DESC' },
    });
  }

  async getRulesMatrix() {
    const rules = await this.ruleRepository.find();
    const hostels = await this.hostelRepository.find({ relations: ['rooms'] });

    const matrix: Record<
      number,
      {
        years: Record<number, boolean>;
        wings: Record<string, Record<number, boolean>>;
      }
    > = {};

    // Initialize matrix with hostels and their wings
    for (const hostel of hostels) {
      const wings = [
        ...new Set(hostel.rooms.map((r) => r.wing).filter((w) => !!w)),
      ];
      matrix[hostel.id] = {
        years: {},
        wings: wings.reduce((acc, wing) => ({ ...acc, [wing!]: {} }), {}),
      };
    }

    for (const rule of rules) {
      if (rule.hostelId === null || rule.year === null) continue;
      if (!matrix[rule.hostelId]) continue; // Skip if hostel no longer exists

      if (rule.wing === null || rule.wing === '') {
        matrix[rule.hostelId].years[rule.year] = rule.isAllowed;
      } else {
        if (!matrix[rule.hostelId].wings[rule.wing]) {
          matrix[rule.hostelId].wings[rule.wing] = {};
        }
        matrix[rule.hostelId].wings[rule.wing][rule.year] = rule.isAllowed;
      }
    }

    return matrix;
  }

  async saveRulesMatrix(
    matrix: Record<
      number,
      {
        years: Record<number, boolean>;
        wings: Record<string, Record<number, boolean>>;
      }
    >,
  ) {
    return await this.dataSource.transaction(async (manager) => {
      // 1. Wipe existing rules using QueryBuilder (avoids "Empty criteria" error)
      await manager
        .createQueryBuilder()
        .delete()
        .from(AllocationRule)
        .execute();

      // 2. Generate new rules
      const newRules: AllocationRule[] = [];
      for (const hostelIdStr of Object.keys(matrix)) {
        const hostelId = parseInt(hostelIdStr);
        const config = matrix[hostelId];

        // Hostel-wide rules
        for (const yearStr of Object.keys(config.years)) {
          const year = parseInt(yearStr);
          // Always save the rule (whether allowed or blocked) to ensure strict enforcement
          newRules.push(
            manager.create(AllocationRule, {
              hostelId,
              year,
              isAllowed: config.years[year],
              priority: 10,
              description: `Auto: Year ${year} in Hostel ID ${hostelId}`,
              wing: null,
            }),
          );
        }

        // Wing-specific rules
        for (const wingName of Object.keys(config.wings)) {
          const yearMap = config.wings[wingName];
          for (const yearStr of Object.keys(yearMap)) {
            const year = parseInt(yearStr);
            // Always save wing-specific rules to override hostel-wide defaults
            newRules.push(
              manager.create(AllocationRule, {
                hostelId,
                year,
                isAllowed: yearMap[year],
                priority: 15, // Wing-specific rules have higher priority
                description: `Auto: Year ${year} in Wing ${wingName} (Hostel ID ${hostelId})`,
                wing: wingName,
              }),
            );
          }
        }
      }

      if (newRules.length > 0) {
        await manager.save(AllocationRule, newRules);
      }

      return {
        message: 'Hierarchical rules matrix saved successfully',
        count: newRules.length,
      };
    });
  }

  async updateAllocationResult(
    resultId: number,
    newRoomId: number,
  ): Promise<AllocationResult> {
    return await this.dataSource.transaction(async (manager) => {
      const result = await manager.findOne(AllocationResult, {
        where: { id: resultId },
        relations: ['room'],
        lock: { mode: 'pessimistic_write' },
      });

      if (!result) {
        throw new NotFoundException('Allocation result not found');
      }

      // Check if allocation run is finalized
      const run = await manager.findOne(AllocationRun, {
        where: { id: result.runId },
      });

      if (!run) {
        throw new NotFoundException('Allocation run not found');
      }

      if (run.finalized) {
        throw new BadRequestException(
          'Cannot modify allocation results of a finalized run',
        );
      }

      // If room is not changing, no need to validate
      if (result.roomId === newRoomId) {
        return result;
      }

      // Verify new room exists
      const newRoom = await manager.findOne(Room, {
        where: { id: newRoomId },
        relations: ['hostel'],
      });

      if (!newRoom) {
        throw new NotFoundException('Room not found');
      }

      // Check room capacity with pessimistic lock to prevent race condition
      const currentAllocations = await manager
        .createQueryBuilder(AllocationResult, 'ar')
        .where('ar.runId = :runId', { runId: result.runId })
        .andWhere('ar.roomId = :roomId', { roomId: newRoomId })
        .setLock('pessimistic_write')
        .getCount();

      if (currentAllocations >= newRoom.capacity) {
        throw new BadRequestException(
          `Room ${newRoom.roomNumber} is at full capacity (${newRoom.capacity}/${newRoom.capacity})`,
        );
      }

      // Update allocation result
      result.roomId = newRoomId;
      result.hostelName = newRoom.hostel.name;
      result.roomNumber = newRoom.roomNumber;
      result.wing = newRoom.wing;
      result.floor = newRoom.floor;

      return manager.save(AllocationResult, result);
    });
  }

  // ============ DASHBOARD STATS ============

  async getDashboardStats(): Promise<any> {
    const [
      totalStudents,
      totalGroups,
      totalHostels,
      totalRooms,
      totalRules,
      latestRun,
    ] = await Promise.all([
      this.studentRepository.count(),
      this.groupRepository.count(),
      this.hostelRepository.count(),
      this.roomRepository.count(),
      this.ruleRepository.count(),
      this.runRepository
        .find({
          order: { startTime: 'DESC' },
          take: 1,
        })
        .then((runs) => runs[0] || null),
    ]);

    const totalBeds = await this.roomRepository
      .createQueryBuilder('room')
      .select('SUM(room.capacity)', 'total')
      .getRawOne();

    const acceptedMemberships = await this.membershipRepository.count({
      where: { status: MembershipStatus.ACCEPTED },
    });

    return {
      totalStudents,
      totalGroups,
      studentsInGroups: acceptedMemberships,
      totalHostels,
      totalRooms,
      totalBeds: parseInt(totalBeds?.total || '0'),
      totalRules,
      latestAllocationRun: latestRun
        ? {
            id: latestRun.id,
            status: latestRun.status,
            startTime: latestRun.startTime,
            endTime: latestRun.endTime,
            totalStudents: latestRun.totalStudents,
            allocatedStudents: latestRun.allocatedStudents,
          }
        : null,
    };
  }

  // ============ WING PARTICIPATION SETTINGS ============

  async setWingParticipation(
    year: number,
    isAllowed: boolean,
  ): Promise<WingParticipationSetting> {
    const existing = await this.wingParticipationRepository.findOne({
      where: { year },
    });

    if (existing) {
      existing.isAllowed = isAllowed;
      return this.wingParticipationRepository.save(existing);
    }

    const setting = this.wingParticipationRepository.create({
      year,
      isAllowed,
    });
    return this.wingParticipationRepository.save(setting);
  }

  async getWingParticipationSettings(): Promise<WingParticipationSetting[]> {
    return this.wingParticipationRepository.find({
      order: { year: 'ASC' },
    });
  }

  async isWingParticipationAllowed(year: number): Promise<boolean> {
    const setting = await this.wingParticipationRepository.findOne({
      where: { year },
    });
    return setting ? setting.isAllowed : true;
  }

  // ============ SYSTEM SETTINGS (ALLOCATION POLICY) ============

  async getAllocationPolicy(): Promise<string> {
    const setting = await this.systemSettingRepository.findOne({
      where: { key: 'allocationPolicy' },
    });
    return setting ? setting.value : 'group_based';
  }

  async setAllocationPolicy(policy: string): Promise<{ policy: string }> {
    const existing = await this.systemSettingRepository.findOne({
      where: { key: 'allocationPolicy' },
    });

    if (existing) {
      existing.value = policy;
      await this.systemSettingRepository.save(existing);
    } else {
      const setting = this.systemSettingRepository.create({
        key: 'allocationPolicy',
        value: policy,
      });
      await this.systemSettingRepository.save(setting);
    }

    return { policy };
  }

  // ============ SYSTEM SETTINGS (APPLICATIONS ENABLED) ============

  async getApplicationsEnabled(): Promise<boolean> {
    const setting = await this.systemSettingRepository.findOne({
      where: { key: 'applicationsEnabled' },
    });
    // Default to true if not set (to avoid blocking during setup)
    return setting ? setting.value === 'true' : true;
  }

  async setApplicationsEnabled(
    enabled: boolean,
  ): Promise<{ enabled: boolean }> {
    const existing = await this.systemSettingRepository.findOne({
      where: { key: 'applicationsEnabled' },
    });

    const value = enabled ? 'true' : 'false';

    if (existing) {
      existing.value = value;
      await this.systemSettingRepository.save(existing);
    } else {
      const setting = this.systemSettingRepository.create({
        key: 'applicationsEnabled',
        value: value,
      });
      await this.systemSettingRepository.save(setting);
    }

    return { enabled };
  }

  // ============ SYSTEM SETTINGS (GENERAL) ============
  async getSystemSettings(): Promise<Record<string, string>> {
    const settings = await this.systemSettingRepository.find();
    const result: Record<string, string> = {};
    settings.forEach((s) => (result[s.key] = s.value));
    return result;
  }

  async updateSystemSetting(key: string, value: string): Promise<SystemSetting> {
    let setting = await this.systemSettingRepository.findOne({ where: { key } });
    if (setting) {
      setting.value = value;
    } else {
      setting = this.systemSettingRepository.create({ key, value });
    }
    return this.systemSettingRepository.save(setting);
  }

  // ============ STUDENT ELIGIBILITY ============
  async getStudentEligibility(userId: string, ignoreVisibility = false): Promise<StudentEligibility> {
    const student = await this.studentRepository.findOne({ where: { userId } });
    if (!student) throw new NotFoundException('Student not found');

    const settings = await this.getSystemSettings();
    const showEligibility = settings['show_eligibility_to_students'] === 'true';
    const showBatchCapacity = settings['show_batch_capacity_to_students'] === 'true';
    
    if (!showEligibility && !ignoreVisibility) {
      return { enabled: false, hostels: [] };
    }

    const hostels = await this.hostelRepository.find({ relations: ['rooms'] });
    const allRules = await this.ruleRepository.find({ order: { priority: 'DESC' } });

    const eligibleHostels: {
      id: number;
      name: string;
      wings: {
        name: string;
        maxRoommates: number;
        totalSpots: number;
      }[];
    }[] = [];

    for (const hostel of hostels) {
      if (hostel.genderType === 'male' && student.gender !== 'male') continue;
      if (hostel.genderType === 'female' && student.gender !== 'female') continue;

      const wingsMap = new Map<string, any>();

      hostel.rooms.forEach((room) => {
        const wingName = room.wing || 'Default';
        if (!wingsMap.has(wingName)) {
          wingsMap.set(wingName, {
            name: wingName,
            maxCapacity: 0,
            totalCohortSpots: 0,
            isAllowed: true, 
          });
        }
        const wing = wingsMap.get(wingName);
        
        // We calculate max roommate limit from physical room capacity
        if (room.capacity > wing.maxCapacity) {
          wing.maxCapacity = room.capacity;
        }

        // We will sum spots only if the cohort is allowed in this specific wing
        // But we check rule for the WHOLE WING first to avoid per-room loops later
      });

      const allowedWings: {
        name: string;
        maxRoommates: number;
        totalSpots: number;
      }[] = [];
      for (const [wingName, wingInfo] of wingsMap.entries()) {
        let isBlocked = false;
        
        for (const rule of allRules) {
          const hostelMatch = !rule.hostelId || rule.hostelId === hostel.id;
          const yearMatch = !rule.year || rule.year === student.year;
          const wingMatch = !rule.wing || rule.wing === wingName;

          if (hostelMatch && yearMatch && wingMatch) {
            if (!rule.isAllowed) {
              isBlocked = true;
            }
            break; 
          }
        }

        if (!isBlocked) {
          // Calculate total spots for this cohort in this wing
          const cohortSpots = hostel.rooms
            .filter(r => (r.wing || 'Default') === wingName)
            .reduce((sum, r) => sum + r.capacity, 0);

          allowedWings.push({
            name: wingName,
            maxRoommates: Math.max(0, wingInfo.maxCapacity - 1),
            totalSpots: cohortSpots,
          });
        }
      }

    if (allowedWings.length > 0) {
        eligibleHostels.push({
          id: hostel.id,
          name: hostel.name,
          wings: allowedWings,
        });
      }
    }

    const globalMaxGroupSize = eligibleHostels.reduce((max, h) => {
      const hostelMax = h.wings.reduce((wm, w) => Math.max(wm, w.totalSpots), 0);
      return Math.max(max, hostelMax);
    }, 0);

    const globalMaxRoommates = eligibleHostels.reduce((max, h) => {
      const hostelMax = h.wings.reduce((wm, w) => Math.max(wm, w.maxRoommates), 0);
      return Math.max(max, hostelMax);
    }, 0);

    return {
      enabled: true,
      showRoommateLimits: settings['show_roommate_limits_to_students'] === 'true',
      showBatchCapacity,
      globalMaxGroupSize,
      globalMaxRoommates,
      hostels: eligibleHostels,
    };
  }
}
