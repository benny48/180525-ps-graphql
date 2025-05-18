import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { EmployeeService } from './employee.service';
import { Employee } from './employee.type';
import { EmployeeEntity } from './entities/employee.entity/employee.entity';

@Resolver(() => Employee)
export class EmployeeResolver {
  constructor(private readonly employeeService: EmployeeService) {}

  @Query(() => [Employee])
  async employees() {
    return this.employeeService.getEmployees();
  }

  @Mutation(() => Employee)
  async createEmployee(
    @Args('name') name: string,
    @Args('job_title') job_title: string,
  ) {
    return this.employeeService.createEmployee(name, job_title);
  }

  @Query(() => EmployeeEntity, { name: 'validateEmployee' })
  async validateEmployee(
    @Args('username', { description: 'Trainer username' }) username: string,
    @Args('password', { description: 'Trainer password' }) password: string,
  ) {
    return this.employeeService.validateEmployee(username, password);
  }
}
