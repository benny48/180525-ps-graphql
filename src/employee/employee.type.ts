import { ObjectType, Field, ID } from '@nestjs/graphql';

@ObjectType()
export class Employee {
  @Field(() => ID)
  id: number;

  @Field()
  name: string;

  @Field()
  job_title: string;
}
