import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { OdooAuthService } from '../odoo-auth/odoo-auth.service';
import { CreateAttendanceDto } from './dto/create-attendance.dto/create-attendance.dto';
import * as moment from 'moment-timezone';

@Injectable()
export class AttendanceService {
  constructor(private readonly odooAuthService: OdooAuthService) {}

  private readonly odooUrl = process.env.ODOO_URL;

  async createAttendance(input: CreateAttendanceDto): Promise<any> {
    const uid = await this.odooAuthService.authenticate();
    if (!uid) throw new Error('Gagal autentikasi ke Odoo');

    // Convert input tanggal_absen (WIB) to UTC before sending to Odoo
    const formattedDate = this.convertWIBtoUTC(input.tanggal_absen);
    const dayOfWeek = this.getDayOfWeek(input.tanggal_absen);
    const timeInFloat = this.convertTimeToFloat(input.tanggal_absen);
    const tanggal = this.convertToDateOnly(input.tanggal_absen);
    const base64Image = this.cleanBase64(input.attendace_image);

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

    const result = response.data.result;
    console.log('ODoo response:', response.data);
    if (!result) throw new Error('Gagal membuat attendance');
    return result; // ini biasanya ID dari record yang dibuat
  }

  // Fungsi baru untuk mendapatkan data absensi berdasarkan employee ID dan tanggal hari ini
  async getAttendanceByEmployeeIdToday(employeeId: number): Promise<any> {
    const uid = await this.odooAuthService.authenticate();
    if (!uid) throw new Error('Gagal autentikasi ke Odoo');

    // Mendapatkan tanggal hari ini dalam format YYYY-MM-DD
    const todayDate = moment().tz('Asia/Jakarta').format('YYYY-MM-DD');

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

    const result = response.data.result;
    console.log('Odoo attendance response:', response.data);

    // Return empty array if no attendance records found
    if (!result) return [];

    return result;
  }

  // Hapus prefix "data:image/...;base64,"
  private cleanBase64(base64String: string): string {
    if (base64String.includes('base64,')) {
      return base64String.split('base64,')[1]; // hanya base64 tanpa prefix
    }
    return base64String;
  }

  // Function to convert local WIB time (DD/MM/YYYY HH:mm:ss) to UTC
  private convertWIBtoUTC(date: string): string {
    // Parse the input date (DD/MM/YYYY HH:mm:ss)
    const parsedDate = moment(date, 'DD/MM/YYYY HH:mm:ss');

    // Convert to UTC by subtracting 7 hours (WIB -> UTC)
    const utcDate = parsedDate.subtract(7, 'hours'); // Convert WIB to UTC

    // Format the UTC time to the required format (YYYY-MM-DD HH:mm:ss)
    return utcDate.format('YYYY-MM-DD HH:mm:ss'); // Return UTC time
  }

  // Function to get the day of the week from the input date in Indonesian
  private getDayOfWeek(date: string): string {
    // Parse the input date (DD/MM/YYYY)
    const parsedDate = moment(date, 'DD/MM/YYYY HH:mm:ss');

    // Mapping day of the week in English to Indonesian
    const dayOfWeekInEnglish = parsedDate.format('dddd');
    const dayOfWeekInIndonesian =
      this.translateDayToIndonesian(dayOfWeekInEnglish);

    return dayOfWeekInIndonesian; // Return day of the week in Indonesian
  }

  // Function to translate English day of the week to Indonesian
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

    return daysInIndonesian[day] || day; // Return the translated day
  }

  // Function to convert time into float (hours in decimal format)
  private convertTimeToFloat(date: string): number {
    // Parse the input date (DD/MM/YYYY HH:mm:ss)
    const parsedDate = moment(date, 'DD/MM/YYYY HH:mm:ss');

    // Extract hours and minutes
    const hours = parsedDate.hour();
    const minutes = parsedDate.minute();

    // Convert minutes to decimal
    const minutesInDecimal = minutes / 60;

    // Combine hours and decimal minutes
    const timeInFloat = hours + minutesInDecimal;

    return timeInFloat; // Return time as float
  }

  // Function to convert date to YYYY-MM-DD (Date Only)
  private convertToDateOnly(date: string): string {
    // Parse the input date (DD/MM/YYYY HH:mm:ss)
    const parsedDate = moment(date, 'DD/MM/YYYY HH:mm:ss');

    // Return the date part in format YYYY-MM-DD
    return parsedDate.format('YYYY-MM-DD'); // Return date only (no time)
  }
}
