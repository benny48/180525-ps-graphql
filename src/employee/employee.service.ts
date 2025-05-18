import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { OdooAuthService } from '../odoo-auth/odoo-auth.service';

@Injectable()
export class EmployeeService {
  constructor(private readonly odooAuthService: OdooAuthService) {}

  private readonly odooUrl = process.env.ODOO_URL;

  async getEmployees(): Promise<any[]> {
    const uid = await this.odooAuthService.authenticate();
    if (!uid) throw new Error('Gagal autentikasi ke Odoo');

    const response = await axios.post(this.odooUrl, {
      jsonrpc: '2.0',
      method: 'call',
      id: new Date().getTime(),
      params: {
        service: 'object',
        method: 'execute_kw',
        args: [
          process.env.ODOO_DB,
          uid,
          process.env.ODOO_PASSWORD,
          'hr.employee',
          'search_read',
          [[]],
          {
            fields: [
              'id',
              'name',
              'username',
              'password',
              'position',
              'latitude',
              'longitude',
              'lock_location',
              'mobile_id',
              'distance_work',
            ],
          },
        ],
      },
    });

    return response.data.result;
  }

  async createEmployee(name: string, job_title: string): Promise<any> {
    const uid = await this.odooAuthService.authenticate();
    if (!uid) throw new Error('Gagal autentikasi ke Odoo');

    const response = await axios.post(this.odooUrl, {
      jsonrpc: '2.0',
      method: 'call',
      id: new Date().getTime(),
      params: {
        service: 'object',
        method: 'execute_kw',
        args: [
          process.env.ODOO_DB,
          uid,
          process.env.ODOO_PASSWORD,
          'hr.employee',
          'create',
          [{ name, job_title }],
        ],
      },
    });

    const newEmployeeId = response.data.result;
    return { id: newEmployeeId, name, job_title };
  }

  async validateEmployee(username: string, password: string): Promise<any> {
    const trainers = await this.getEmployees();
    const trainer = trainers.find(
      (tr) => tr.username === username && tr.password === password,
    );

    if (!trainer) {
      throw new Error('Username atau password salah');
    }

    return trainer;
  }
}
