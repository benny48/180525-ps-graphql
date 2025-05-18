import { Injectable } from '@nestjs/common';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config(); // Load environment variables dari .env

@Injectable()
export class OdooAuthService {
  private readonly odooUrl = process.env.ODOO_URL;
  private readonly db = process.env.ODOO_DB;
  private readonly username = process.env.ODOO_USERNAME;
  private readonly password = process.env.ODOO_PASSWORD;

  async authenticate(): Promise<number> {
    const response = await axios.post(this.odooUrl, {
      jsonrpc: '2.0',
      method: 'call',
      id: new Date().getTime(),
      params: {
        service: 'common',
        method: 'authenticate',
        args: [this.db, this.username, this.password, {}],
      },
    });

    if (!response.data.result) {
      throw new Error('Gagal autentikasi ke Odoo');
    }

    return response.data.result;
  }
}
