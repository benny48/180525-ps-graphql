import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { AttendanceService } from './attendance.service';
import { CreateAttendanceDto } from './dto/create-attendance.dto/create-attendance.dto';
import { Attendance } from './attendance.entity';

@Resolver()
export class AttendanceResolver {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Query(() => [Attendance], { name: 'getAttendanceByEmployeeIdToday' })
  async getAttendanceByEmployeeIdToday(
    @Args('employeeId', { type: () => Int }) employeeId: number,
  ) {
    return this.attendanceService.getAttendanceByEmployeeIdToday(employeeId);
  }

  @Mutation(() => Int)
  async createAttendance(@Args('input') input: CreateAttendanceDto) {
    return this.attendanceService.createAttendance(input);
  }
}
