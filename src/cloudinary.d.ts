declare module "cloudinary" {
  export const v2: {
    config(options: {
      cloud_name: string;
      api_key: string;
      api_secret: string;
      secure?: boolean;
    }): void;
    uploader: {
      upload(file: string, options: Record<string, unknown>): Promise<{ secure_url?: string }>;
    };
  };
}
