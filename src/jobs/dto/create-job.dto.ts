import { IsNotEmpty, IsString, IsUrl } from 'class-validator';

export class CreateJobDto {
  @IsString()
  @IsNotEmpty()
  patientId: string;

  @IsString()
  @IsNotEmpty()
  studyType: string;

  @IsUrl()
  callbackUrl: string;
}
