my $name = $ENV{NAME} // "world";
print "Hello from Perl!\n";
my %result = (message => "Hello, $name!", squares => [map { $_ * $_ } 0..5]);
\%result;
