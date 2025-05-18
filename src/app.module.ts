import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { EmployeeModule } from './employee/employee.module';
import { join } from 'path';
import { OdooAuthService } from './odoo-auth/odoo-auth.service';
import { AttendanceService } from './attendance/attendance.service';
import { AttendanceResolver } from './attendance/attendance.resolver';
import { AttendanceModule } from './attendance/attendance.module';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
    }),
    EmployeeModule,
    AttendanceModule,
  ],
  controllers: [AppController],
  providers: [AppService, OdooAuthService, AttendanceService, AttendanceResolver],
})
export class AppModule {}
