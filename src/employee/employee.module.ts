import { Module } from '@nestjs/common';
import { EmployeeService } from './employee.service';
import { EmployeeResolver } from './employee.resolver';
import { OdooAuthService } from 'src/odoo-auth/odoo-auth.service';

@Module({
  providers: [EmployeeService, EmployeeResolver, OdooAuthService],
})
export class EmployeeModule {}
