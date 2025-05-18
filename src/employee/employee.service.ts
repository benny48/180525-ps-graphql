import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { OdooAuthService } from '../odoo-auth/odoo-auth.service';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class EmployeeService {
  private readonly logger = new Logger(EmployeeService.name);

  constructor(
    private readonly odooAuthService: OdooAuthService,
    private readonly redisService: RedisService,
  ) {}

  private readonly odooUrl = process.env.ODOO_URL;
  private readonly CACHE_TTL = 3600; // 1 jam dalam detik
  private readonly EMPLOYEE_CACHE_KEY = 'employees:all';

  async getEmployees(): Promise<any[]> {
    // Cek cache terlebih dahulu
    const cachedEmployees = await this.redisService.get(
      this.EMPLOYEE_CACHE_KEY,
    );
    if (cachedEmployees) {
      this.logger.log('✅ Data karyawan diambil dari REDIS cache');
      return JSON.parse(cachedEmployees);
    }

    this.logger.log('⚠️ Cache miss! Mengambil data karyawan dari ODOO...');

    // Jika tidak ada di cache, ambil dari Odoo
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

    const employees = response.data.result;

    // Simpan ke cache
    await this.redisService.set(
      this.EMPLOYEE_CACHE_KEY,
      JSON.stringify(employees),
      this.CACHE_TTL,
    );

    this.logger.log(
      `✅ Data ${employees.length} karyawan berhasil disimpan ke cache (TTL: ${this.CACHE_TTL}s)`,
    );

    return employees;
  }

  async createEmployee(name: string, job_title: string): Promise<any> {
    this.logger.log(`🔄 Membuat karyawan baru: ${name}, ${job_title}`);

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
    const newEmployee = { id: newEmployeeId, name, job_title };

    // Invalidasi cache karena data berubah
    await this.redisService.del(this.EMPLOYEE_CACHE_KEY);
    this.logger.log('🗑️ Cache karyawan diinvalidasi karena ada data baru');

    return newEmployee;
  }

  async validateEmployee(username: string, password: string): Promise<any> {
    // Cek di cache terlebih dahulu
    const cacheKey = `employee:validate:${username}`;
    const cachedEmployee = await this.redisService.get(cacheKey);

    if (cachedEmployee) {
      this.logger.log(
        `✅ Data validasi untuk ${username} diambil dari REDIS cache`,
      );
      const employee = JSON.parse(cachedEmployee);
      // Verifikasi password dari cache
      if (employee.password === password) {
        return employee;
      }
      this.logger.log(
        `⚠️ Password tidak cocok untuk cached user ${username}, mencoba dari sumber data`,
      );
    }

    // Jika tidak ada di cache atau password tidak cocok
    this.logger.log(
      `⚠️ Cache miss untuk validasi ${username}, mengambil data dari ODOO...`,
    );
    const employees = await this.getEmployees();
    const employee = employees.find(
      (emp) => emp.username === username && emp.password === password,
    );

    if (!employee) {
      this.logger.warn(
        `❌ Validasi gagal: Username ${username} atau password salah`,
      );
      throw new Error('Username atau password salah');
    }

    // Simpan hasil validasi ke cache selama 30 menit
    await this.redisService.set(
      cacheKey,
      JSON.stringify(employee),
      1800, // 30 menit
    );
    this.logger.log(
      `✅ Data validasi untuk ${username} disimpan ke cache (TTL: 1800s)`,
    );

    return employee;
  }
}
