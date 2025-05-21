import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { OdooAuthService } from '../odoo-auth/odoo-auth.service';
import { RedisService } from '../redis/redis.service';
import { CreateAttendanceDto } from './dto/create-attendance.dto/create-attendance.dto';
import * as moment from 'moment-timezone';

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly odooAuthService: OdooAuthService,
    private readonly redisService: RedisService,
  ) {}

  private readonly odooUrl = process.env.ODOO_URL;
  private readonly ATTENDANCE_CACHE_TTL = 900; // 15 menit dalam detik
  private readonly RANGE_CACHE_TTL = 1800; // 30 menit untuk data historis
  private readonly MAX_RETRY_ATTEMPTS = 3;

  // Helper untuk membuat kunci cache berdasarkan employeeId dan tanggal
  private getAttendanceCacheKey(employeeId: number, date?: string): string {
    const formattedDate =
      date || moment().tz('Asia/Jakarta').format('YYYY-MM-DD');
    return `attendance:employee:${employeeId}:date:${formattedDate}`;
  }

  // Helper untuk membuat kunci cache range
  private getRangeCacheKey(startDate: string, endDate: string): string {
    return `attendance:range:${startDate}:${endDate}`;
  }

  // Simple transformation untuk handle berbagai format field 'name' dari Odoo
  private normalizeOdooData(data: any): any {
    return data.map((item: any) => ({
      ...item,
      // Convert name field menjadi string sederhana
      name: this.extractNameAsString(item.name),
    }));
  }

  // Extract name field menjadi string, handle berbagai format
  private extractNameAsString(nameField: any): string {
    if (Array.isArray(nameField)) {
      // Format: [employee_id, "Employee Name"] -> return "Employee Name"
      return nameField[1] || nameField[0]?.toString() || '';
    } else if (typeof nameField === 'object' && nameField !== null) {
      // Format: {id: employee_id, name: "Employee Name"} -> return "Employee Name"
      return nameField.name || nameField.id?.toString() || '';
    } else {
      // Format: employee_id atau string -> return as string
      return nameField?.toString() || '';
    }
  }

  // Helper untuk mencari semua cache keys yang mungkin terpengaruh oleh update
  private async getRelatedCacheKeys(
    employeeId: number,
    date: string,
  ): Promise<string[]> {
    const cacheKeys = [
      // Cache employee hari ini
      this.getAttendanceCacheKey(employeeId, date),
    ];

    try {
      // Cari range cache keys yang mungkin include tanggal ini
      const pattern = `attendance:range:*`;
      const rangeCacheKeys = await this.redisService.keys(pattern);

      // Filter range cache yang include tanggal ini
      for (const key of rangeCacheKeys) {
        const matches = key.match(
          /attendance:range:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})/,
        );
        if (matches) {
          const [, startDate, endDate] = matches;
          if (moment(date).isBetween(startDate, endDate, null, '[]')) {
            cacheKeys.push(key);
          }
        }
      }
    } catch (error) {
      this.logger.warn(
        `⚠️ Gagal mendapatkan related cache keys: ${error.message}`,
      );
    }

    return cacheKeys;
  }

  // Implementasi retry logic dengan exponential backoff
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries: number = this.MAX_RETRY_ATTEMPTS,
  ): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        this.logger.warn(
          `${operationName} attempt ${attempt}/${maxRetries} failed: ${error.message}`,
        );

        if (attempt === maxRetries) {
          this.logger.error(
            `${operationName} failed after ${maxRetries} attempts`,
          );
          throw error;
        }

        // Exponential backoff: 100ms, 200ms, 400ms
        const delay = Math.pow(2, attempt - 1) * 100;
        await this.delay(delay);
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Update cache secara atomic dengan data baru
  private async atomicCacheUpdate(
    employeeId: number,
    newAttendanceData: any,
    date: string,
  ): Promise<void> {
    const cacheKey = this.getAttendanceCacheKey(employeeId, date);

    await this.executeWithRetry(async () => {
      const multi = this.redisService.multi();

      try {
        // Watch the cache key for changes
        await this.redisService.watch(cacheKey);

        // Get existing data
        const existingData = await this.redisService.get(cacheKey);
        let updatedData = [newAttendanceData];

        if (existingData) {
          const parsed = JSON.parse(existingData);

          // Check if attendance for same punching_type already exists today
          const existingIndex = parsed.findIndex(
            (attendance: any) =>
              attendance.punching_type === newAttendanceData.punching_type,
          );

          if (existingIndex >= 0) {
            // Update existing record
            parsed[existingIndex] = newAttendanceData;
            updatedData = parsed;
          } else {
            // Add new record
            updatedData = [...parsed, newAttendanceData];
          }
        }

        // Set the updated data
        multi.set(
          cacheKey,
          JSON.stringify(updatedData),
          'EX',
          this.ATTENDANCE_CACHE_TTL,
        );

        const results = await multi.exec();

        if (results) {
          this.logger.log(
            `✅ Cache berhasil diupdate untuk employee ${employeeId}`,
          );
          await this.trackCachePerformance('cache_update_success', employeeId);
        } else {
          this.logger.warn(`⚠️ Cache update dibatalkan karena data berubah`);
          throw new Error(
            'Cache update cancelled due to concurrent modification',
          );
        }
      } catch (error) {
        await this.redisService.unwatch();
        throw error;
      }
    }, 'Atomic Cache Update');
  }

  // Invalidasi multiple cache keys secara batch
  private async batchInvalidateCache(cacheKeys: string[]): Promise<void> {
    if (cacheKeys.length === 0) return;

    await this.executeWithRetry(async () => {
      const pipeline = this.redisService.pipeline();
      cacheKeys.forEach((key) => pipeline.del(key));

      const results = await pipeline.exec();
      const successCount = results?.filter(([err]) => !err).length || 0;

      this.logger.log(
        `🗑️ ${successCount}/${cacheKeys.length} cache keys berhasil di-invalidasi`,
      );

      await this.trackCachePerformance('cache_invalidation', 0);
    }, 'Batch Cache Invalidation');
  }

  // Cache preloading untuk data yang sering diakses
  private async preloadFrequentlyAccessedCache(
    employeeId: number,
  ): Promise<void> {
    // Fire-and-forget preloading (tidak block main operation)
    setImmediate(async () => {
      try {
        const currentDate = moment().tz('Asia/Jakarta');

        // Preload cache untuk minggu ini
        const startOfWeek = currentDate
          .clone()
          .startOf('week')
          .format('YYYY-MM-DD');
        const endOfWeek = currentDate
          .clone()
          .endOf('week')
          .format('YYYY-MM-DD');

        // Preload cache untuk bulan ini
        const startOfMonth = currentDate
          .clone()
          .startOf('month')
          .format('YYYY-MM-DD');
        const endOfMonth = currentDate
          .clone()
          .endOf('month')
          .format('YYYY-MM-DD');

        // Preload both weekly and monthly data
        await Promise.allSettled([
          this.getAttendanceByDateRange(startOfWeek, endOfWeek),
          this.getAttendanceByDateRange(startOfMonth, endOfMonth),
        ]);

        this.logger.log(
          `🔄 Cache preloading selesai untuk employee ${employeeId}`,
        );
        await this.trackCachePerformance('cache_preload_success', employeeId);
      } catch (error) {
        this.logger.warn(`⚠️ Cache preloading gagal: ${error.message}`);
        await this.trackCachePerformance('cache_preload_error', employeeId);
      }
    });
  }

  // Track cache performance untuk monitoring
  private async trackCachePerformance(
    operation: string,
    employeeId: number,
  ): Promise<void> {
    try {
      const today = moment().tz('Asia/Jakarta').format('YYYY-MM-DD');
      const metricsKey = `cache:metrics:${today}`;

      // Track daily metrics
      const multi = this.redisService.multi();
      multi.hincrby(metricsKey, `total_${operation}`, 1);
      multi.hincrby(metricsKey, `employee_${employeeId}_${operation}`, 1);
      multi.expire(metricsKey, 86400 * 7); // Keep metrics for 7 days

      await multi.exec();
    } catch (error) {
      // Don't fail the main operation if metrics fail
      this.logger.warn(`Gagal track metrics: ${error.message}`);
    }
  }

  async createAttendance(input: CreateAttendanceDto): Promise<any> {
    this.logger.log(
      `🔄 Membuat attendance baru untuk karyawan ID: ${input.employeeId}`,
    );

    const uid = await this.odooAuthService.authenticate();
    if (!uid) throw new Error('Gagal autentikasi ke Odoo');

    // Convert input tanggal_absen (WIB) to UTC before sending to Odoo
    const formattedDate = this.convertWIBtoUTC(input.tanggal_absen);
    const dayOfWeek = this.getDayOfWeek(input.tanggal_absen);
    const timeInFloat = this.convertTimeToFloat(input.tanggal_absen);
    const tanggal = this.convertToDateOnly(input.tanggal_absen);
    const base64Image = this.cleanBase64(input.attendace_image);

    // Buat attendance record ke Odoo
    const response = await this.executeWithRetry(async () => {
      return await axios.post(this.odooUrl, {
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
            'ssm.attendance',
            'create',
            [
              {
                name: input.employeeId,
                nik: input.nik,
                hari: dayOfWeek,
                tanggal_absen: formattedDate,
                time: timeInFloat,
                tangal: tanggal,
                punching_type: input.punching_type,
                attendace_image: base64Image,
              },
            ],
          ],
        },
      });
    }, 'Create Attendance');

    const result = response.data.result;
    if (!result) {
      this.logger.error('❌ Gagal membuat attendance di Odoo');
      throw new Error('Gagal membuat attendance');
    }

    // Siapkan data untuk cache update (format Odoo, consistent dengan API response)
    const newAttendanceData = {
      id: result,
      name: input.employeeId.toString(), // Store as string for consistency
      nik: input.nik,
      hari: dayOfWeek,
      tanggal_absen: formattedDate,
      time: timeInFloat,
      tangal: tanggal,
      punching_type: input.punching_type,
      attendace_image: base64Image,
    };

    try {
      // 1. Update cache secara atomic dengan data baru
      await this.atomicCacheUpdate(
        input.employeeId,
        newAttendanceData,
        tanggal,
      );

      // 2. Invalidasi cache range yang terkait
      const relatedCacheKeys = await this.getRelatedCacheKeys(
        input.employeeId,
        tanggal,
      );
      const rangeCacheKeys = relatedCacheKeys.filter((key) =>
        key.includes('range:'),
      );

      if (rangeCacheKeys.length > 0) {
        await this.batchInvalidateCache(rangeCacheKeys);
      }

      // 3. Preload cache untuk data yang sering diakses
      await this.preloadFrequentlyAccessedCache(input.employeeId);

      // 4. Track success metrics
      await this.trackCachePerformance(
        'create_attendance_success',
        input.employeeId,
      );
    } catch (cacheError) {
      // Jika semua cache operations gagal, fallback ke invalidasi manual
      this.logger.error(`❌ Cache operations gagal: ${cacheError.message}`);

      try {
        const fallbackCacheKey = this.getAttendanceCacheKey(
          input.employeeId,
          tanggal,
        );
        await this.redisService.del(fallbackCacheKey);
        this.logger.log(`🔄 Fallback: Cache invalidation berhasil`);
      } catch (fallbackError) {
        this.logger.error(
          `❌ Fallback cache invalidation juga gagal: ${fallbackError.message}`,
        );
      }

      await this.trackCachePerformance(
        'cache_operation_error',
        input.employeeId,
      );
    }

    this.logger.log(
      `✅ Attendance berhasil dibuat untuk karyawan ID ${input.employeeId} dengan ID: ${result}`,
    );

    return result;
  }

  // Fungsi untuk mendapatkan data absensi berdasarkan employee ID dan tanggal hari ini
  async getAttendanceByEmployeeIdToday(employeeId: number): Promise<any> {
    // Cek cache terlebih dahulu
    const cacheKey = this.getAttendanceCacheKey(employeeId);

    try {
      const cachedAttendance = await this.redisService.get(cacheKey);

      if (cachedAttendance) {
        this.logger.log(
          `✅ Data attendance untuk karyawan ID ${employeeId} diambil dari REDIS cache`,
        );
        await this.trackCachePerformance('cache_hit', employeeId);
        const parsedData = JSON.parse(cachedAttendance);

        // Apply simple normalization untuk ensure GraphQL compatibility
        return this.normalizeOdooData(parsedData);
      }
    } catch (cacheError) {
      this.logger.warn(`⚠️ Cache read error: ${cacheError.message}`);
    }

    // Cache miss - ambil dari Odoo
    await this.trackCachePerformance('cache_miss', employeeId);

    this.logger.log(
      `⚠️ Cache miss! Mengambil data attendance untuk karyawan ID ${employeeId} dari ODOO...`,
    );

    const uid = await this.odooAuthService.authenticate();
    if (!uid) throw new Error('Gagal autentikasi ke Odoo');

    // Mendapatkan tanggal hari ini dalam format YYYY-MM-DD
    const todayDate = moment().tz('Asia/Jakarta').format('YYYY-MM-DD');

    const response = await this.executeWithRetry(async () => {
      return await axios.post(this.odooUrl, {
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
            'ssm.attendance',
            'search_read',
            [
              [
                ['name.id', '=', employeeId],
                ['tangal', '=', todayDate],
              ],
            ],
            {
              fields: [
                'name',
                'nik',
                'hari',
                'tanggal_absen',
                'time',
                'tangal',
                'punching_type',
                'attendace_image',
              ],
            },
          ],
        },
      });
    }, 'Get Attendance by Employee ID');

    const rawResult = response.data.result || [];

    // Simpan raw data ke cache (maintain consistency)
    try {
      await this.redisService.set(
        cacheKey,
        JSON.stringify(rawResult),
        this.ATTENDANCE_CACHE_TTL,
      );

      this.logger.log(
        `✅ Data ${rawResult.length} attendance untuk karyawan ID ${employeeId} disimpan ke cache (TTL: ${this.ATTENDANCE_CACHE_TTL}s)`,
      );
    } catch (cacheError) {
      this.logger.warn(`⚠️ Gagal menyimpan ke cache: ${cacheError.message}`);
    }

    // Return normalized data untuk GraphQL
    return this.normalizeOdooData(rawResult);
  }

  // Fungsi untuk mendapatkan semua attendance berdasarkan rentang tanggal
  async getAttendanceByDateRange(
    startDate: string,
    endDate: string,
  ): Promise<any> {
    const cacheKey = this.getRangeCacheKey(startDate, endDate);

    try {
      const cachedData = await this.redisService.get(cacheKey);

      if (cachedData) {
        this.logger.log(
          `✅ Data attendance untuk rentang ${startDate} - ${endDate} diambil dari REDIS cache`,
        );
        await this.trackCachePerformance('range_cache_hit', 0);
        const parsedData = JSON.parse(cachedData);

        // Apply simple normalization untuk ensure GraphQL compatibility
        return this.normalizeOdooData(parsedData);
      }
    } catch (cacheError) {
      this.logger.warn(`⚠️ Range cache read error: ${cacheError.message}`);
    }

    // Cache miss
    await this.trackCachePerformance('range_cache_miss', 0);

    this.logger.log(
      `⚠️ Cache miss! Mengambil data attendance untuk rentang ${startDate} - ${endDate} dari ODOO...`,
    );

    const uid = await this.odooAuthService.authenticate();
    if (!uid) throw new Error('Gagal autentikasi ke Odoo');

    const response = await this.executeWithRetry(async () => {
      return await axios.post(this.odooUrl, {
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
            'ssm.attendance',
            'search_read',
            [
              [
                ['tangal', '>=', startDate],
                ['tangal', '<=', endDate],
              ],
            ],
            {
              fields: [
                'name',
                'nik',
                'hari',
                'tanggal_absen',
                'time',
                'tangal',
                'punching_type',
              ],
            },
          ],
        },
      });
    }, 'Get Attendance by Date Range');

    const rawResult = response.data.result || [];

    // Simpan raw data ke cache (maintain consistency)
    try {
      await this.redisService.set(
        cacheKey,
        JSON.stringify(rawResult),
        this.RANGE_CACHE_TTL,
      );

      this.logger.log(
        `✅ Data ${rawResult.length} attendance untuk rentang tanggal disimpan ke cache (TTL: ${this.RANGE_CACHE_TTL}s)`,
      );
    } catch (cacheError) {
      this.logger.warn(`⚠️ Gagal menyimpan range cache: ${cacheError.message}`);
    }

    // Return normalized data untuk GraphQL
    return this.normalizeOdooData(rawResult);
  }

  // Method untuk mendapatkan cache metrics
  async getCacheMetrics(date?: string): Promise<any> {
    try {
      const targetDate =
        date || moment().tz('Asia/Jakarta').format('YYYY-MM-DD');
      const metricsKey = `cache:metrics:${targetDate}`;

      const metrics = await this.redisService.hgetall(metricsKey);

      if (!metrics || Object.keys(metrics).length === 0) {
        return {
          date: targetDate,
          message: 'No metrics available for this date',
        };
      }

      // Parse metrics untuk format yang lebih readable
      const parsedMetrics = {
        date: targetDate,
        cache_operations: {},
        employee_specific: {},
      };

      for (const [key, value] of Object.entries(metrics)) {
        if (key.startsWith('employee_')) {
          const matches = key.match(/employee_(\d+)_(.+)/);
          if (matches) {
            const [, employeeId, operation] = matches;
            if (!parsedMetrics.employee_specific[employeeId]) {
              parsedMetrics.employee_specific[employeeId] = {};
            }
            parsedMetrics.employee_specific[employeeId][operation] =
              parseInt(value);
          }
        } else if (key.startsWith('total_')) {
          const operation = key.replace('total_', '');
          parsedMetrics.cache_operations[operation] = parseInt(value);
        }
      }

      return parsedMetrics;
    } catch (error) {
      this.logger.error(`Gagal mengambil cache metrics: ${error.message}`);
      throw new Error('Failed to retrieve cache metrics');
    }
  }

  // Method untuk clear semua cache (untuk maintenance)
  async clearAllCache(): Promise<void> {
    try {
      const patterns = [
        'attendance:employee:*',
        'attendance:range:*',
        'cache:metrics:*',
      ];

      let totalCleared = 0;

      for (const pattern of patterns) {
        const keys = await this.redisService.keys(pattern);
        if (keys.length > 0) {
          const pipeline = this.redisService.pipeline();
          keys.forEach((key) => pipeline.del(key));
          await pipeline.exec();
          totalCleared += keys.length;
        }
      }

      this.logger.log(`✅ ${totalCleared} cache keys berhasil dihapus`);
    } catch (error) {
      this.logger.error(`❌ Gagal clear cache: ${error.message}`);
      throw new Error('Failed to clear cache');
    }
  }

  // Existing helper methods (unchanged)
  private cleanBase64(base64String: string): string {
    if (base64String.includes('base64,')) {
      return base64String.split('base64,')[1];
    }
    return base64String;
  }

  private convertWIBtoUTC(date: string): string {
    const parsedDate = moment(date, 'DD/MM/YYYY HH:mm:ss');
    const utcDate = parsedDate.subtract(7, 'hours');
    return utcDate.format('YYYY-MM-DD HH:mm:ss');
  }

  private getDayOfWeek(date: string): string {
    const parsedDate = moment(date, 'DD/MM/YYYY HH:mm:ss');
    const dayOfWeekInEnglish = parsedDate.format('dddd');
    const dayOfWeekInIndonesian =
      this.translateDayToIndonesian(dayOfWeekInEnglish);
    return dayOfWeekInIndonesian;
  }

  private translateDayToIndonesian(day: string): string {
    const daysInIndonesian = {
      Sunday: 'Minggu',
      Monday: 'Senin',
      Tuesday: 'Selasa',
      Wednesday: 'Rabu',
      Thursday: 'Kamis',
      Friday: 'Jumat',
      Saturday: 'Sabtu',
    };
    return daysInIndonesian[day] || day;
  }

  private convertTimeToFloat(date: string): number {
    const parsedDate = moment(date, 'DD/MM/YYYY HH:mm:ss');
    const hours = parsedDate.hour();
    const minutes = parsedDate.minute();
    const minutesInDecimal = minutes / 60;
    const timeInFloat = hours + minutesInDecimal;
    return timeInFloat;
  }

  private convertToDateOnly(date: string): string {
    const parsedDate = moment(date, 'DD/MM/YYYY HH:mm:ss');
    return parsedDate.format('YYYY-MM-DD');
  }
}
