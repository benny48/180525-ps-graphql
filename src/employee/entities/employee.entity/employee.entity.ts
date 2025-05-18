import { ObjectType, Field, Int } from '@nestjs/graphql';

@ObjectType({ description: 'Employee Entity' }) // Menambahkan deskripsi
export class EmployeeEntity {
  @Field(() => Int, { description: 'Unique ID' })
  id: number;

  @Field({ description: 'Full Name of the Employee' })
  name: string;

  @Field({ description: 'Username for authentication' })
  username: string;

  @Field({ description: 'Password (hashed for security)' })
  password: string;

  @Field({ description: 'Position of the Employee' })
  position: string;

  @Field({ description: 'Latitude of the Employee location' })
  latitude: string;

  @Field({ description: 'Longitude of the Employee location' })
  longitude: string;

  @Field({ description: 'Lock Location' })
  lock_location: string;

  @Field({ description: 'Mobile ID of the Employee' })
  mobile_id: string;

  @Field({ description: 'Distance from work location' })
  distance_work: string;
}
