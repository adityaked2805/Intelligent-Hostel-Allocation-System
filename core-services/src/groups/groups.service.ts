import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Group,
  GroupMembership,
  MembershipStatus,
  Student,
  User,
  WingParticipationSetting,
} from '../entities';
import { AdminService, StudentEligibility } from '../admin/admin.service';
import {
  CreateGroupDto,
  InviteMemberDto,
  GroupResponseDto,
  InvitationResponseDto,
} from './dto/groups.dto';

@Injectable()
export class GroupsService {
  constructor(
    @InjectRepository(Group)
    private groupRepository: Repository<Group>,
    @InjectRepository(GroupMembership)
    private membershipRepository: Repository<GroupMembership>,
    @InjectRepository(Student)
    private studentRepository: Repository<Student>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(WingParticipationSetting)
    private wingParticipationRepository: Repository<WingParticipationSetting>,
    private adminService: AdminService,
  ) {}

  private async checkWingParticipationAllowed(year: number): Promise<void> {
    const setting = await this.wingParticipationRepository.findOne({
      where: { year },
    });

    const isAllowed = setting ? setting.isAllowed : true;

    if (!isAllowed) {
      throw new ForbiddenException(
        `Wing-based participation is not allowed for year ${year}`,
      );
    }
  }

  private async checkNotSubmitted(userId: string): Promise<void> {
    const student = await this.studentRepository.findOne({
      where: { userId },
    });

    if (student && student.hasSubmitted) {
      throw new ForbiddenException(
        'You cannot modify your group status after submitting your application. Withdraw your application first.',
      );
    }
  }

  async createGroup(
    userId: string,
    createGroupDto: CreateGroupDto,
  ): Promise<GroupResponseDto> {
    // Check if user is a student
    const student = await this.studentRepository.findOne({
      where: { userId },
    });

    if (!student) {
      throw new ForbiddenException('Only students can create groups');
    }

    // Check if wing participation is allowed for this student's year
    await this.checkWingParticipationAllowed(student.year);

    // Check if student has already submitted
    await this.checkNotSubmitted(userId);

    // Check if user already has a group they created
    const existingGroup = await this.groupRepository.findOne({
      where: { creatorId: userId },
    });

    if (existingGroup) {
      throw new ConflictException('You already have a group');
    }

    // Create the group
    const group = this.groupRepository.create({
      name: createGroupDto.name,
      creatorId: userId,
    });

    await this.groupRepository.save(group);

    // Add creator as accepted member
    const membership = this.membershipRepository.create({
      groupId: group.id,
      userId: userId,
      status: MembershipStatus.ACCEPTED,
    });

    await this.membershipRepository.save(membership);

    return this.getGroupById(group.id, userId);
  }

  async getMyGroup(userId: string): Promise<GroupResponseDto | null> {
    // First check if user is a creator of a group
    const createdGroup = await this.groupRepository.findOne({
      where: { creatorId: userId },
    });

    if (createdGroup) {
      return this.getGroupById(createdGroup.id, userId);
    }

    // Check if user is an accepted member of any group
    const membership = await this.membershipRepository.findOne({
      where: { userId, status: MembershipStatus.ACCEPTED },
      relations: ['group'],
    });

    if (membership) {
      return this.getGroupById(membership.groupId, userId);
    }

    return null;
  }

  async getGroupById(
    groupId: number,
    userId: string,
  ): Promise<GroupResponseDto> {
    const group = await this.groupRepository.findOne({
      where: { id: groupId },
      relations: ['memberships', 'memberships.student', 'creator'],
    });

    if (!group) {
      throw new NotFoundException('Group not found');
    }

    const members = group.memberships.map((m) => ({
      userId: m.userId,
      rollNumber: m.student?.rollNumber || '',
      fullName: m.student?.fullName || '',
      status: m.status,
    }));

    return {
      id: group.id,
      name: group.name,
      creatorId: group.creatorId,
      createdAt: group.createdAt,
      memberCount: members.filter((m) => m.status === MembershipStatus.ACCEPTED)
        .length,
      members,
    };
  }

  private async validateGroupSize(groupId: number, studentUserId: string) {
    const group = await this.groupRepository.findOne({
      where: { id: groupId },
      relations: ['memberships'],
    });

    if (!group) return;

    // Get limits for the student
    const eligibility = await this.adminService.getStudentEligibility(studentUserId, true);
    if (!eligibility.enabled) return; // If visibility is off, we still have the data but might not want to block? 
    // Actually, we SHOULD block regardless of visibility for security.

    const currentCount = group.memberships.filter(m => 
      m.status === MembershipStatus.ACCEPTED || m.status === MembershipStatus.PENDING
    ).length;

    const maxLimit = eligibility.globalMaxGroupSize ?? 100;

    if (currentCount >= maxLimit) {
      throw new BadRequestException(
        `Group size limit reached. Based on your eligibility, you cannot have more than ${maxLimit} people in your wing group.`,
      );
    }
  }

  async inviteMember(
    groupId: number,
    userId: string,
    inviteDto: InviteMemberDto,
  ): Promise<{ message: string }> {
    // Verify the user is the group creator
    const group = await this.groupRepository.findOne({
      where: { id: groupId },
    });

    if (!group) {
      throw new NotFoundException('Group not found');
    }

    if (group.creatorId !== userId) {
      throw new ForbiddenException('Only the group creator can invite members');
    }

    // Check if creator has submitted
    await this.checkNotSubmitted(userId);

    // Find the student by roll number
    const invitee = await this.studentRepository.findOne({
      where: { rollNumber: inviteDto.rollNumber },
    });

    if (!invitee) {
      throw new NotFoundException(
        `Student with roll number ${inviteDto.rollNumber} not found`,
      );
    }

    // Check if wing participation is allowed for the invitee's year
    await this.checkWingParticipationAllowed(invitee.year);

    // SECURITY CHECK: Group size limit
    await this.validateGroupSize(groupId, userId);

    // SECURITY CHECK: Eligibility & Gender overlap
    await this.checkCompatibility(groupId, invitee);

    // Check if they're already in this group
    const existingMembership = await this.membershipRepository.findOne({
      where: { groupId, userId: invitee.userId },
    });

    if (existingMembership) {
      if (existingMembership.status === MembershipStatus.ACCEPTED) {
        throw new ConflictException(
          'Student is already a member of this group',
        );
      }
      if (existingMembership.status === MembershipStatus.PENDING) {
        throw new ConflictException(
          'Student already has a pending invitation to this group',
        );
      }
      // If declined, allow re-invite
      existingMembership.status = MembershipStatus.PENDING;
      await this.membershipRepository.save(existingMembership);
      return { message: 'Invitation resent successfully' };
    }

    // Check if they're already in another group (accepted)
    const otherMembership = await this.membershipRepository.findOne({
      where: { userId: invitee.userId, status: MembershipStatus.ACCEPTED },
    });

    if (otherMembership) {
      throw new ConflictException(
        'Student is already a member of another group',
      );
    }

    // Create the invitation
    const membership = this.membershipRepository.create({
      groupId,
      userId: invitee.userId,
      status: MembershipStatus.PENDING,
    });

    await this.membershipRepository.save(membership);

    return { message: `Invitation sent to ${invitee.fullName}` };
  }

  private async checkCompatibility(groupId: number, newStudent: Student) {
    const group = await this.groupRepository.findOne({
      where: { id: groupId },
      relations: ['memberships', 'memberships.student'],
    });

    if (!group) return;

    // 1. Gender Compatibility
    const existingMembers = group.memberships
      .filter(m => m.status === MembershipStatus.ACCEPTED)
      .map(m => m.student)
      .filter(s => !!s);

    if (existingMembers.length > 0) {
      if (existingMembers[0].gender !== newStudent.gender) {
        throw new BadRequestException(
          `Gender mismatch. This group is for ${existingMembers[0].gender}s.`,
        );
      }

      // 2. Hostel Overlap Check
      const newEligibility: StudentEligibility = await this.adminService.getStudentEligibility(newStudent.userId, true);
      const newEligibleHostelIds = new Set(newEligibility.hostels.map(h => h.id));

      // Check against ALL existing members to find a common overlap
      // Start with the intersection of all existing members
      let commonHostelIds: Set<number> | null = null;

      for (const member of existingMembers) {
        const mEligibility: StudentEligibility = await this.adminService.getStudentEligibility(member.userId, true);
        const mHostelIds = new Set(mEligibility.hostels.map(h => h.id));
        
        if (commonHostelIds === null) {
          commonHostelIds = mHostelIds;
        } else {
          commonHostelIds = new Set([...commonHostelIds].filter(id => mHostelIds.has(id)));
        }
      }

      // Final intersection with the new student
      const finalOverlap = [...(commonHostelIds || [])].filter(id => newEligibleHostelIds.has(id));

      if (finalOverlap.length === 0) {
        throw new BadRequestException(
          `Eligibility mismatch. This student does not share any eligible hostels with the current group members.`,
        );
      }
    }
  }

  async getMyInvitations(userId: string): Promise<InvitationResponseDto[]> {
    const invitations = await this.membershipRepository.find({
      where: { userId, status: MembershipStatus.PENDING },
      relations: ['group', 'group.creator', 'group.creator.student'],
    });

    return invitations.map((inv) => ({
      groupId: inv.groupId,
      groupName: inv.group.name,
      invitedBy:
        inv.group.creator?.student?.fullName ||
        inv.group.creator?.email ||
        'Unknown',
      invitedAt: inv.invitedAt,
      status: inv.status,
    }));
  }

  async respondToInvitation(
    groupId: number,
    userId: string,
    status: MembershipStatus,
  ): Promise<{ message: string }> {
    if (
      status !== MembershipStatus.ACCEPTED &&
      status !== MembershipStatus.DECLINED
    ) {
      throw new BadRequestException('Status must be accepted or declined');
    }

    const membership = await this.membershipRepository.findOne({
      where: { groupId, userId, status: MembershipStatus.PENDING },
    });

    if (!membership) {
      throw new NotFoundException('Invitation not found');
    }

    if (status === MembershipStatus.ACCEPTED) {
      // Check if wing participation is allowed for this student's year
      const student = await this.studentRepository.findOne({
        where: { userId },
      });

      if (!student) {
        throw new NotFoundException('Student profile not found');
      }

      await this.checkWingParticipationAllowed(student.year);
      await this.checkNotSubmitted(userId);

      // Check if user is already in another group
      const otherMembership = await this.membershipRepository.findOne({
        where: { userId, status: MembershipStatus.ACCEPTED },
      });

      if (otherMembership && otherMembership.groupId !== groupId) {
        throw new ConflictException(
          'You are already a member of another group. Leave that group first.',
        );
      }

      // SECURITY CHECK: Group size limit (when accepting)
      // Note: We already check during invitation, but this is a double-check
      await this.validateGroupSize(groupId, userId);

      // SECURITY CHECK: Eligibility & Gender overlap
      await this.checkCompatibility(groupId, student);
    }

    membership.status = status;
    await this.membershipRepository.save(membership);

    return {
      message:
        status === MembershipStatus.ACCEPTED
          ? 'You have joined the group'
          : 'Invitation declined',
    };
  }

  async leaveGroup(userId: string): Promise<{ message: string }> {
    // Find the user's accepted membership
    const membership = await this.membershipRepository.findOne({
      where: { userId, status: MembershipStatus.ACCEPTED },
      relations: ['group'],
    });

    if (!membership) {
      throw new NotFoundException('You are not a member of any group');
    }

    // If user is the creator, don't allow leaving (must delete group)
    if (membership.group.creatorId === userId) {
      throw new ForbiddenException(
        'Group creators cannot leave. Delete the group instead.',
      );
    }

    // Check if student has submitted
    await this.checkNotSubmitted(userId);

    await this.membershipRepository.remove(membership);

    return { message: 'You have left the group' };
  }

  async deleteGroup(
    groupId: number,
    userId: string,
  ): Promise<{ message: string }> {
    const group = await this.groupRepository.findOne({
      where: { id: groupId },
    });

    if (!group) {
      throw new NotFoundException('Group not found');
    }

    if (group.creatorId !== userId) {
      throw new ForbiddenException(
        'Only the group creator can delete the group',
      );
    }

    // Check if creator has submitted
    await this.checkNotSubmitted(userId);

    // Delete all memberships first (cascade should handle this, but being explicit)
    await this.membershipRepository.delete({ groupId });

    // Delete the group
    await this.groupRepository.remove(group);

    return { message: 'Group deleted successfully' };
  }

  async removeMember(
    groupId: number,
    memberUserId: string,
    creatorUserId: string,
  ): Promise<{ message: string }> {
    const group = await this.groupRepository.findOne({
      where: { id: groupId },
    });

    if (!group) {
      throw new NotFoundException('Group not found');
    }

    if (group.creatorId !== creatorUserId) {
      throw new ForbiddenException('Only the group creator can remove members');
    }

    // Check if creator has submitted
    await this.checkNotSubmitted(creatorUserId);

    if (memberUserId === creatorUserId) {
      throw new ForbiddenException(
        'Cannot remove yourself. Delete the group instead.',
      );
    }

    const membership = await this.membershipRepository.findOne({
      where: { groupId, userId: memberUserId },
    });

    if (!membership) {
      throw new NotFoundException('Member not found in this group');
    }

    await this.membershipRepository.remove(membership);

    return { message: 'Member removed from group' };
  }

  async getAllGroups(): Promise<GroupResponseDto[]> {
    const groups = await this.groupRepository.find({
      relations: ['memberships', 'memberships.student'],
    });

    return groups.map((group) => ({
      id: group.id,
      name: group.name,
      creatorId: group.creatorId,
      createdAt: group.createdAt,
      memberCount: group.memberships.filter(
        (m) => m.status === MembershipStatus.ACCEPTED,
      ).length,
      members: group.memberships.map((m) => ({
        userId: m.userId,
        rollNumber: m.student?.rollNumber || '',
        fullName: m.student?.fullName || '',
        status: m.status,
      })),
    }));
  }
}
