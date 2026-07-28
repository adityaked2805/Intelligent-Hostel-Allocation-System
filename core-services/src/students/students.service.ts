import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, IsNull } from 'typeorm';
import { Student, SystemSetting } from '../entities';
import { UpdateStudentDto } from './dto/update-student.dto';

@Injectable()
export class StudentsService {
  constructor(
    @InjectRepository(Student)
    private studentRepository: Repository<Student>,
    @InjectRepository(SystemSetting)
    private systemSettingRepository: Repository<SystemSetting>,
  ) {}

  async findAll() {
    return this.studentRepository.find({
      relations: ['user', 'currentRoom', 'currentRoom.hostel', 'allocatedRoom', 'allocatedRoom.hostel'],
      order: {
        year: 'ASC',
        fullName: 'ASC',
      },
    });
  }

  async findOne(userId: string) {
    const student = await this.studentRepository.findOne({
      where: { userId },
      relations: ['user', 'currentRoom', 'currentRoom.hostel'],
    });

    if (!student) {
      throw new NotFoundException('Student not found');
    }

    return student;
  }

  async findByRollNumber(rollNumber: string) {
    const student = await this.studentRepository.findOne({
      where: { rollNumber },
      relations: ['user'],
    });

    if (!student) {
      throw new NotFoundException('Student not found');
    }

    return student;
  }

  async findEligibleForSwap(userId: string) {
    const requester = await this.findOne(userId);

    return this.studentRepository.find({
      where: {
        gender: requester.gender,
        currentRoomId: Not(IsNull()),
        userId: Not(userId),
      },
      relations: ['currentRoom', 'currentRoom.hostel'],
    });
  }

  async update(userId: string, updateStudentDto: UpdateStudentDto) {
    const student = await this.findOne(userId);

    Object.assign(student, updateStudentDto);
    return this.studentRepository.save(student);
  }

  async apply(userId: string) {
    const setting = await this.systemSettingRepository.findOne({
      where: { key: 'applicationsEnabled' },
    });
    const enabled = setting ? setting.value === 'true' : true;

    if (!enabled) {
      throw new ForbiddenException(
        'Hostel applications are currently closed by the administration.',
      );
    }

    return this.studentRepository.update(userId, {
      applicationTimestamp: new Date(),
      hasSubmitted: true,
      applicationStatus: 'SUBMITTED',
    });
  }
}
