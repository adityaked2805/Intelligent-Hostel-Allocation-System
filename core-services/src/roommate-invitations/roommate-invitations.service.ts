import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  RoommateInvitation,
  RoommateInvitationStatus,
  Student,
  GroupMembership,
  MembershipStatus,
  SystemSetting,
} from '../entities';
import { SendRoommateInvitationDto } from './dto/send-invitation.dto';
import { RespondToInvitationDto } from './dto/respond-invitation.dto';

@Injectable()
export class RoommateInvitationsService {
  constructor(
    @InjectRepository(RoommateInvitation)
    private invitationRepository: Repository<RoommateInvitation>,
    @InjectRepository(Student)
    private studentRepository: Repository<Student>,
    @InjectRepository(GroupMembership)
    private membershipRepository: Repository<GroupMembership>,
    @InjectRepository(SystemSetting)
    private systemSettingRepository: Repository<SystemSetting>,
  ) {}

  async checkFcfsMode() {
    const policy = await this.systemSettingRepository.findOne({
      where: { key: 'active_allocation_policy' },
    });
    if (policy?.value === 'fcfs') {
      throw new BadRequestException(
        'Roommate invitations are disabled in FCFS mode',
      );
    }
  }

  private async checkNotSubmitted(userId: string): Promise<void> {
    const student = await this.studentRepository.findOne({
      where: { userId },
    });

    if (student && student.hasSubmitted) {
      throw new ForbiddenException(
        'You cannot modify your roommate status after submitting your application. Withdraw your application first.',
      );
    }
  }

  async sendInvitation(
    senderId: string,
    dto: SendRoommateInvitationDto,
  ) {
    await this.checkFcfsMode();
    await this.checkNotSubmitted(senderId);

    // 1. Check if sender is in a group
    const senderMembership = await this.membershipRepository.findOne({
      where: { userId: senderId, status: MembershipStatus.ACCEPTED },
    });

    if (!senderMembership) {
      throw new BadRequestException('You must be in a group to send a roommate invitation');
    }

    // 2. Find receiver
    const receiver = await this.studentRepository.findOne({
      where: { rollNumber: dto.receiverRollNumber },
    });

    if (!receiver) {
      throw new NotFoundException('Receiver student not found');
    }

    if (receiver.userId === senderId) {
      throw new BadRequestException('You cannot invite yourself');
    }

    // 3. Check if receiver is in the same group
    const receiverMembership = await this.membershipRepository.findOne({
      where: { 
        userId: receiver.userId, 
        groupId: senderMembership.groupId,
        status: MembershipStatus.ACCEPTED 
      },
    });

    if (!receiverMembership) {
      throw new BadRequestException('Receiver must be in the same group as you');
    }

    // 4. Check if receiver already has an accepted roommate invitation
    const existingAccepted = await this.invitationRepository.findOne({
      where: [
        { senderId: receiver.userId, status: RoommateInvitationStatus.ACCEPTED },
        { receiverId: receiver.userId, status: RoommateInvitationStatus.ACCEPTED },
      ],
    });

    if (existingAccepted) {
      throw new ConflictException('Receiver already has an accepted roommate invitation');
    }

    // 5. Check if sender already has an accepted roommate invitation
    const senderAccepted = await this.invitationRepository.findOne({
      where: [
        { senderId: senderId, status: RoommateInvitationStatus.ACCEPTED },
        { receiverId: senderId, status: RoommateInvitationStatus.ACCEPTED },
      ],
    });

    if (senderAccepted) {
        throw new ConflictException('You already have an accepted roommate invitation');
    }

    // 6. Check for pending invitation
    const existingPending = await this.invitationRepository.findOne({
      where: {
        senderId,
        receiverId: receiver.userId,
        status: RoommateInvitationStatus.PENDING,
      },
    });

    if (existingPending) {
      throw new ConflictException('Invitation already pending');
    }

    const invitation = this.invitationRepository.create({
      senderId,
      receiverId: receiver.userId,
      groupId: senderMembership.groupId,
      status: RoommateInvitationStatus.PENDING,
    });

    return this.invitationRepository.save(invitation);
  }

  async respondToInvitation(
    userId: string,
    invitationId: number,
    dto: RespondToInvitationDto,
  ) {
    await this.checkFcfsMode();
    await this.checkNotSubmitted(userId);

    const invitation = await this.invitationRepository.findOne({
      where: { id: invitationId, receiverId: userId },
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.status !== RoommateInvitationStatus.PENDING) {
      throw new BadRequestException('Invitation is no longer pending');
    }

    if (dto.status === 'accepted') {
        // Check if user already has another accepted invitation
        const userAccepted = await this.invitationRepository.findOne({
            where: [
                { senderId: userId, status: RoommateInvitationStatus.ACCEPTED },
                { receiverId: userId, status: RoommateInvitationStatus.ACCEPTED },
            ],
        });

        if (userAccepted) {
            throw new ConflictException('You already have an accepted roommate invitation');
        }

        invitation.status = RoommateInvitationStatus.ACCEPTED;
        
        // Cancel all other pending invitations for this user (both sent and received)
        await this.invitationRepository.update(
            { receiverId: userId, status: RoommateInvitationStatus.PENDING },
            { status: RoommateInvitationStatus.CANCELLED }
        );
        await this.invitationRepository.update(
            { senderId: userId, status: RoommateInvitationStatus.PENDING },
            { status: RoommateInvitationStatus.CANCELLED }
        );
        // Also cancel for the sender
        await this.invitationRepository.update(
            { receiverId: invitation.senderId, status: RoommateInvitationStatus.PENDING },
            { status: RoommateInvitationStatus.CANCELLED }
        );
        await this.invitationRepository.update(
            { senderId: invitation.senderId, status: RoommateInvitationStatus.PENDING },
            { status: RoommateInvitationStatus.CANCELLED }
        );
    } else {
      invitation.status = RoommateInvitationStatus.REJECTED;
    }

    return this.invitationRepository.save(invitation);
  }

  async getMyInvitations(userId: string) {
    return this.invitationRepository.find({
      where: [
        { senderId: userId },
        { receiverId: userId },
      ],
      relations: ['sender', 'receiver', 'group'],
      order: { createdAt: 'DESC' },
    });
  }
}
