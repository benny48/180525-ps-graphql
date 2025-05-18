import { ObjectType, Field, Int, Float } from '@nestjs/graphql';

@ObjectType()
export class Attendance {
  @Field(() => Int)
  id: number;

  @Field(() => [String])
  name: string; // String representation of [id, name] array from Odoo

  @Field(() => Int, { nullable: true })
  employeeId?: number; // Extracted employee ID from name array

  @Field(() => String, { nullable: true })
  employeeName?: string; // Extracted employee name from name array

  @Field(() => String, { nullable: true })
  nik?: string;

  @Field(() => String, { nullable: true })
  hari?: string;

  @Field(() => String)
  tanggal_absen: string;

  @Field(() => Float, { nullable: true })
  time?: number;

  @Field(() => String)
  tangal: string; // tanggal dalam format YYYY-MM-DD

  @Field(() => String, { nullable: true })
  punching_type?: string;

  @Field(() => String, { nullable: true })
  attendace_image?: string;
}
